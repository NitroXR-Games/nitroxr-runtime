import worker from '../index.js';

// Runs in CI (`node worker/test/smoke.mjs` from the repo root).
// Uses no KV binding, so it exercises the in-memory fallback.
const env = {};
let pass = 0, fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`ok: ${name}`);
  } catch (e) {
    fail++;
    console.error(`FAIL: ${name}: ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const req = (path, opts = {}) => new Request(`https://api.nitroxr.io${path}`, opts);

await check('GET /health', async () => {
  const r = await worker.fetch(req('/health'), env);
  assert(r.status === 200, `status ${r.status}`);
  assert((await r.json()).ok === true, 'ok flag');
});

await check('GET /assets/maze_wall_concrete (seed)', async () => {
  const r = await worker.fetch(req('/assets/maze_wall_concrete'), env);
  assert(r.status === 200, `status ${r.status}`);
  const b = await r.json();
  assert(b.id === 'maze_wall_concrete', 'id');
  assert(b.glb_url.startsWith('https://assets.nitroxr.io/'), `glb_url ${b.glb_url}`);
});

await check('GET /assets/nope (404)', async () => {
  const r = await worker.fetch(req('/assets/nope'), env);
  assert(r.status === 404, `status ${r.status}`);
});

await check('POST /assets + GET roundtrip', async () => {
  const entry = { id: 'test_rifle', type: 'model', glb_url: 'https://cdn.example.com/rifle.glb' };
  const w = await worker.fetch(req('/assets', { method: 'POST', body: JSON.stringify(entry) }), env);
  assert(w.status === 201, `write status ${w.status}`);
  const b = await (await worker.fetch(req('/assets/test_rifle'), env)).json();
  assert(b.glb_url === entry.glb_url, 'glb roundtrip');
});

await check('POST /submit + GET /leaderboard ordering', async () => {
  for (const [u, v] of [['alice', 50], ['bob', 120], ['cara', 80]]) {
    const r = await worker.fetch(req('/submit', { method: 'POST', body: JSON.stringify({ userId: u, value: v, gameId: 'maze' }) }), env);
    assert(r.status === 200, `submit ${u} status ${r.status}`);
  }
  const b = await (await worker.fetch(req('/leaderboard/maze?limit=2'), env)).json();
  assert(b.scores.length === 2, `limit ${b.scores.length}`);
  assert(b.scores[0].userId === 'bob', 'top score');
});

await check('POST /submit invalid (400)', async () => {
  const r = await worker.fetch(req('/submit', { method: 'POST', body: JSON.stringify({ userId: 'x' }) }), env);
  assert(r.status === 400, `status ${r.status}`);
});

await check('POST + GET /ghost roundtrip', async () => {
  const path = [{ x: 1, z: 1, t: 0 }, { x: 2, z: 1, t: 100 }];
  const w = await worker.fetch(req('/ghost/pro_player_1?gameId=maze', { method: 'POST', body: JSON.stringify({ path }) }), env);
  assert(w.status === 201, `write status ${w.status}`);
  const b = await (await worker.fetch(req('/ghost/pro_player_1?gameId=maze'), env)).json();
  assert(b.path.length === 2, 'path length');
});

await check('GET /ghost/nobody (404)', async () => {
  const r = await worker.fetch(req('/ghost/nobody?gameId=maze'), env);
  assert(r.status === 404, `status ${r.status}`);
});

await check('OPTIONS preflight', async () => {
  const r = await worker.fetch(req('/assets', { method: 'OPTIONS' }), env);
  assert(r.status === 204, `status ${r.status}`);
  assert(r.headers.get('Access-Control-Allow-Origin') === '*', 'cors header');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
