// AssetResolver tests with a stubbed fetch. Verifies the audio/model split and
// the cache. Run: node client/test/assets.mjs (wired into CI).
import { AssetResolver } from '../src/AssetResolver.js';

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`ok: ${name}`); }
  catch (e) { fail++; console.error(`FAIL: ${name}: ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }

function stubFetch(body, ok = true) {
  globalThis.fetch = async () => ({ ok, status: ok ? 200 : 404, json: async () => body });
}

await check('audio asset resolves without a model and is tagged', async () => {
  stubFetch({ id: 'a', type: 'audio', audio_url: 'https://cdn/a.ogg' });
  const r = new AssetResolver(null, 'http://x');
  const a = await r.resolve('a');
  assert(a.kind === 'audio', 'should be tagged as audio');
  assert(!('model' in a), 'must not carry a model');
  assert(a.metadata.audio_url === 'https://cdn/a.ogg', 'audio_url must survive');
});

await check('an asset with both glb_url and audio_url still loads its model', async () => {
  stubFetch({ id: 'm', type: 'model', glb_url: 'https://cdn/m.glb', audio_url: 'https://cdn/m.ogg' });
  const r = new AssetResolver(null, 'http://x');
  r.loader = { loadAsync: async () => ({ scene: { traverse() {}, scale: { set() {} } } }) };
  const a = await r.resolve('m');
  assert(a.kind !== 'audio', 'a model with an audio_url must not be treated as audio');
  assert(a.model, 'model should be present');
});

await check('missing glb_url falls back to a placeholder, not a throw', async () => {
  stubFetch({ id: 't', type: 'material' });
  const r = new AssetResolver(null, 'http://x');
  const a = await r.resolve('t');
  assert(a && a.model, 'expected the fallback model');
});

await check('a 404 resolves to the error fallback rather than rejecting', async () => {
  stubFetch({}, false);
  const r = new AssetResolver(null, 'http://x');
  const a = await r.resolve('missing');
  assert(a && a.model, 'expected fallback model on failure');
  assert(a.metadata && a.metadata.error === true, 'error should be flagged');
});

await check('resolved assets are cached (second resolve does not refetch)', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ id: 'a', type: 'audio', audio_url: 'https://cdn/a.ogg' }) }; };
  const r = new AssetResolver(null, 'http://x');
  await r.resolve('a');
  await r.resolve('a');
  assert(calls === 1, `expected 1 fetch, got ${calls}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
