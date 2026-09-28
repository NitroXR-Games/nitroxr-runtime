// InputBridge tests. Stand-in window/document record listeners so we can fire
// lifecycle events. Run: node client/test/input.mjs (wired into CI).
import { InputBridge } from '../src/InputBridge.js';

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`ok: ${name}`); }
  catch (e) { fail++; console.error(`FAIL: ${name}: ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }

function installDOM() {
  const win = { listeners: {}, addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }, removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter(x => x !== f); }, fire(t, e = {}) { (this.listeners[t] || []).forEach(f => f(e)); } };
  const doc = { listeners: {}, addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }, removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter(x => x !== f); }, fire(t, e = {}) { (this.listeners[t] || []).forEach(f => f(e)); } };
  globalThis.window = win;
  globalThis.document = doc;
  return { win, doc };
}

await check('keys are released when the window loses focus', () => {
  const { win } = installDOM();
  const b = new InputBridge(null);
  win.fire('keydown', { code: 'KeyW' });
  win.fire('keydown', { code: 'KeyA' });
  assert(b.keys.size === 2, 'precondition: two keys held');
  win.fire('blur');
  assert(b.keys.size === 0, `keys still held after blur: ${[...b.keys]}`);
});

await check('keys are released when the tab becomes hidden', () => {
  const { win, doc } = installDOM();
  const b = new InputBridge(null);
  win.fire('keydown', { code: 'KeyW' });
  assert(b.keys.has('KeyW'), 'precondition: W held');
  doc.fire('visibilitychange', { visibilityState: 'hidden' });
  assert(b.keys.size === 0, `keys still held after tab hide: ${[...b.keys]}`);
});

await check('normal keyup still works', () => {
  const { win } = installDOM();
  const b = new InputBridge(null);
  win.fire('keydown', { code: 'KeyW' });
  win.fire('keyup', { code: 'KeyW' });
  assert(!b.keys.has('KeyW'), 'keyup should release');
});

await check('getInput reflects held state and maps strafe', () => {
  const { win } = installDOM();
  const b = new InputBridge(null);
  win.fire('keydown', { code: 'KeyD' });
  assert(b.getInput().moveX === 1, 'D should be +moveX');
  win.fire('blur');
  assert(b.getInput().moveX === 0, 'blur must clear moveX');
});

await check('dispose removes every listener it added', () => {
  const { win, doc } = installDOM();
  const b = new InputBridge(null);
  b.dispose();
  assert((win.listeners.keydown || []).length === 0, 'keydown listener leaked');
  assert((win.listeners.blur || []).length === 0, 'blur listener leaked');
  assert((doc.listeners.visibilitychange || []).length === 0, 'visibilitychange listener leaked');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
