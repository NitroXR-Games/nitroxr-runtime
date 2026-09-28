// AudioManager unit tests. Node has no Web Audio, so we stand in a fake
// AudioContext that reproduces the API behaviours these tests care about —
// notably that AudioBufferSourceNode.stop() throws once the node has ended.
// Run: node client/test/audio.mjs (wired into CI by deploy.yml).
import { AudioManager } from '../src/AudioManager.js';

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`ok: ${name}`); }
  catch (e) { fail++; console.error(`FAIL: ${name}: ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }

class FakeParam {
  constructor(v = 0) { this.value = v; }
  setValueAtTime(v) { this.value = v; }
  linearRampToValueAtTime(v) { this.value = v; }
  cancelScheduledValues() {}
}
class FakeNode {
  constructor(init) { Object.assign(this, init); }
  connect() { return this; }
}
class FakeSource extends FakeNode {
  constructor() { super({}); this.started = false; this.stopCalls = 0; this.ended = false; this.onended = null; }
  start() { this.started = true; }
  // Simulates the browser ending a non-looping source on its own.
  finish() { if (this.ended) return; this.ended = true; if (this.onended) this.onended(); }
  // Real Web Audio throws if stop() is called on an already-ended node.
  stop() {
    if (this.ended) throw new Error('InvalidStateError');
    this.stopCalls++;
    this.ended = true;
  }
}
function installFakeDOM() {
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.AudioContext = function () {
    return {
      state: 'running', currentTime: 10, destination: new FakeNode({}),
      createGain: () => new FakeNode({ gain: new FakeParam(1) }),
      createBufferSource: () => new FakeSource(),
      createPanner: () => new FakeNode({
        panningModel: '', distanceModel: '', refDistance: 0, maxDistance: 0, rolloffFactor: 0,
        positionX: new FakeParam(0), positionY: new FakeParam(0), positionZ: new FakeParam(0),
        setPosition() {}
      }),
      decodeAudioData: async () => ({ decoded: true }),
      close() { this.state = 'closed'; }
    };
  };
}
installFakeDOM();

const music = { decoded: true };

await check('ensureInitialized is idempotent', () => {
  const a = new AudioManager();
  const c1 = a.ensureInitialized();
  const c2 = a.ensureInitialized();
  assert(c1 && c1 === c2, 'must reuse one context');
});

await check('crossfade after a finished non-looping track does not throw', async () => {
  const a = new AudioManager();
  a.ensureInitialized();
  await a.crossfade(music, { loop: false, fade: 0.1 });
  a.currentMusic.source.finish();             // stinger plays out
  let threw = null;
  try { await a.crossfade(music, { fade: 0.1 }); } catch (e) { threw = e; }
  assert(!threw, `crossfade threw on an ended source: ${threw && threw.message}`);
});

await check('crossfade twice without an ended node fades the first exactly once', async () => {
  const a = new AudioManager();
  a.ensureInitialized();
  await a.crossfade(music, { fade: 0.1 });
  const first = a.currentMusic.source;
  await a.crossfade(music, { fade: 0.1 });
  assert(first.stopCalls === 1, `first source stopped ${first.stopCalls} times`);
  assert(a.currentMusic.source !== first, 'currentMusic should point at the new track');
});

await check('stopMusic is idempotent', async () => {
  const a = new AudioManager();
  a.ensureInitialized();
  await a.crossfade(music, { fade: 0.1 });
  a.stopMusic(0.1);
  a.stopMusic(0.1);
  a.stopMusic(0.1);
  assert(a.currentMusic === null, 'currentMusic should stay cleared');
});

await check('setMasterVolume clamps and initialises lazily', () => {
  const a = new AudioManager();
  a.setMasterVolume(5);
  assert(a.masterGain && a.masterGain.gain.value === 1, 'clamped to 1');
  a.setMasterVolume(-2);
  assert(a.masterGain.gain.value === 0, 'clamped to 0');
});

await check('setCategoryVolume is a no-op for unknown categories', () => {
  const a = new AudioManager();
  a.ensureInitialized();
  a.setCategoryVolume('nope', 0.5);   // must not throw
});

await check('loadAudio rejects a non-OK response before decoding', async () => {
  const a = new AudioManager();
  a.ensureInitialized();
  let decoded = false;
  globalThis.fetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => { decoded = true; return new ArrayBuffer(0); } });
  let threw = null;
  try { await a.loadAudio('https://cdn/missing.ogg'); } catch (e) { threw = e; }
  assert(threw, 'expected loadAudio to throw on 404');
  assert(!decoded, 'must not attempt to decode an error page');
});

await check('spatial panner follows its object', async () => {
  const a = new AudioManager();
  a.ensureInitialized();
  const obj = { position: { x: 1, y: 2, z: 3 } };
  const h = a.createSpatialSource(music, obj);
  assert(h && h.panner.positionX.value === 1, 'should sync on creation');
  obj.position.x = 9;
  a.update();
  assert(h.panner.positionX.value === 9, 'update() should re-sync the panner');
  h.stop();
  a.update();
  assert(a._spatial.size === 0, 'stopped source should be unregistered');
});

await check('dispose closes the context and clears buses', async () => {
  const a = new AudioManager();
  a.ensureInitialized();
  const ctx = a.ctx;
  a.dispose();
  assert(ctx.state === 'closed', 'context should be closed');
  assert(a.ctx === null && a.masterGain === null, 'references should be released');
  assert(a.categoryGains.music === null, 'category buses should be cleared');
  a.dispose(); // must not throw
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
