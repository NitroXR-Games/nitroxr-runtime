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
  assert(b.org === 'nitroxr-games' && b.game === 'maze', 'org/game fields');
  assert(b.glb_url.endsWith('/nitroxr-games/maze/models/maze_wall_concrete.glb'), `namespaced url ${b.glb_url}`);
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
  assert(b.org === 'nitroxr-games' && b.game === 'maze', 'org/game defaults');
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

const post = (path, body) => req(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

await check('POST /assets persists audio_url', async () => {
  const r = await worker.fetch(post('/assets', {
    id: 'smoke_audio', type: 'audio', audio_url: 'https://cdn.example/smoke.ogg'
  }), env);
  assert(r.status === 201, `status ${r.status}`);
  const back = await (await worker.fetch(req('/assets/smoke_audio'), env)).json();
  assert(back.audio_url === 'https://cdn.example/smoke.ogg', `audio_url lost: ${JSON.stringify(back)}`);
});

await check('POST /assets templates {{ASSET_BASE}} in stored URLs', async () => {
  await worker.fetch(post('/assets', {
    id: 'smoke_tmpl', glb_url: '{{ASSET_BASE}}/x/y.glb'
  }), env);
  const back = await (await worker.fetch(req('/assets/smoke_tmpl'), env)).json();
  assert(!back.glb_url.includes('{{ASSET_BASE}}'), `untemplated: ${back.glb_url}`);
});

await check('GET /assets and GET /assets/:id agree on a KV override', async () => {
  await worker.fetch(post('/assets', {
    id: 'maze_wall_concrete', glb_url: 'https://cdn.example/OVR.glb', description: 'override'
  }), env);
  const single = await (await worker.fetch(req('/assets/maze_wall_concrete'), env)).json();
  const list = await (await worker.fetch(req('/assets'), env)).json();
  const inList = list.assets.find(a => a.id === 'maze_wall_concrete');
  assert(single.description === 'override', 'single GET lost the override');
  assert(inList && inList.description === 'override',
    `list disagrees with single GET: ${inList && inList.description}`);
  await worker.fetch(req('/assets/maze_wall_concrete', { method: 'DELETE' }), env);
});

await check('DELETE /assets/:id removes an override and restores the seed', async () => {
  await worker.fetch(post('/assets', {
    id: 'maze_floor_tile', glb_url: 'https://cdn.example/OVR.glb', description: 'override'
  }), env);
  const d = await worker.fetch(req('/assets/maze_floor_tile', { method: 'DELETE' }), env);
  assert(d.status === 200, `delete status ${d.status}`);
  const back = await (await worker.fetch(req('/assets/maze_floor_tile'), env)).json();
  assert(back.description !== 'override', 'override survived deletion — seed is shadowed forever');
  assert(back.description === 'Dark metallic floor tile, seamless tiling', 'seed should be back');
});

await check('every seeded URL field is templated', async () => {
  const list = await (await worker.fetch(req('/assets'), env)).json();
  const leaks = list.assets.filter(a =>
    [a.glb_url, a.texture_url, a.audio_url].some(u => typeof u === 'string' && u.includes('{{ASSET_BASE}}')));
  assert(leaks.length === 0, `untemplated seeds: ${leaks.map(a => a.id).join(', ')}`);
});

await check('seed entries carry no texture_url that was never uploaded', async () => {
  const list = await (await worker.fetch(req('/assets'), env)).json();
  // No texture object exists in R2; a texture_url here is a URL that 404s.
  const withTextures = list.assets.filter(a => a.texture_url);
  assert(withTextures.length === 0,
    `seeds still advertise missing textures: ${withTextures.map(a => a.id).join(', ')}`);
});

await check('every seeded model URL points at the maze_-prefixed object', async () => {
  const { SEED_ASSETS } = await import('../registry.seed.js');
  const stale = Object.values(SEED_ASSETS).filter(a =>
    /\/(wall_plain|floor_tile|goal_portal|player_base|ghost)\.glb$/.test(a.glb_url || ''));
  assert(stale.length === 0,
    `seeds still reference placeholder filenames: ${stale.map(a => a.id).join(', ')}`);
});


// ---------------------------------------------------------------- Lap 7

// The DELETE tests above all call worker.fetch() directly, which BYPASSES CORS
// - so they were green while the feature was unreachable from a browser.
// A real preflight is the only thing that catches a missing Allow-Methods.
await check('CORS preflight permits DELETE (browsers block it otherwise)', async () => {
  const r = await worker.fetch(req('/layouts/a', { method: 'OPTIONS' }), env);
  assert(r.status === 204, `status ${r.status}`);
  const allow = r.headers.get('Access-Control-Allow-Methods') || '';
  assert(allow.includes('DELETE'), `Allow-Methods lacks DELETE: "${allow}"`);
  assert(allow.includes('OPTIONS'), `Allow-Methods lacks OPTIONS: "${allow}"`);
});

const good = { cells: [{ x: 1, z: 1 }, { x: 2, z: 3 }] };
const postLayout = (id, body, gameId = 'maze') =>
  req(`/layouts/${id}?gameId=${gameId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

await check('POST then GET round-trips a layout', async () => {
  const created = await (await worker.fetch(postLayout('t1', good), env)).json();
  assert(created.id === 't1' && created.gameId === 'maze', 'echoes id/gameId');
  assert(created.cells.length === 2, 'keeps cells');
  assert(created.updatedAt, 'stamps updatedAt');
  const got = await (await worker.fetch(req('/layouts/t1?gameId=maze'), env)).json();
  assert(got.cells.length === 2 && got.cells[1].x === 2, `round-trip mismatch: ${JSON.stringify(got.cells)}`);
});

await check('layouts are scoped per gameId', async () => {
  await worker.fetch(postLayout('shared', { cells: [{ x: 9, z: 9 }] }, 'maze'), env);
  const other = await worker.fetch(req('/layouts/shared?gameId=other'), env);
  assert(other.status === 404, `leaked across games: ${other.status}`);
});

await check('missing layout is a 404, not a crash', async () => {
  const r = await worker.fetch(req('/layouts/nope'), env);
  assert(r.status === 404, `status ${r.status}`);
});

await check('POST rejects a non-array cells field', async () => {
  const r = await worker.fetch(postLayout('bad1', { cells: 'walls' }), env);
  assert(r.status === 400, `status ${r.status}`);
});

await check('POST rejects fractional coordinates (they would offset the mesh)', async () => {
  const r = await worker.fetch(postLayout('bad2', { cells: [{ x: 1.5, z: 2 }] }), env);
  assert(r.status === 400, `status ${r.status}`);
});

await check('POST rejects out-of-range coordinates', async () => {
  for (const c of [{ x: -1, z: 0 }, { x: 0, z: 1e9 }, { x: 999, z: 0 }]) {
    const r = await worker.fetch(postLayout('bad3', { cells: [c] }), env);
    assert(r.status === 400, `{${c.x},${c.z}} was accepted`);
  }
});

await check('POST rejects null, strings and arrays masquerading as cells', async () => {
  for (const cells of [[null], ['ab'], [[1, 2]], [3]]) {
    const r = await worker.fetch(postLayout('bad4', { cells }), env);
    assert(r.status === 400, `${JSON.stringify(cells)} was accepted`);
  }
});

await check('POST rejects an empty layout', async () => {
  const r = await worker.fetch(postLayout('bad5', { cells: [] }), env);
  assert(r.status === 400, `status ${r.status}`);
});

await check('POST caps the cell count', async () => {
  const many = Array.from({ length: 2001 }, (_, i) => ({ x: i % 255, z: 0 }));
  const r = await worker.fetch(postLayout('bad6', { cells: many }), env);
  assert(r.status === 400, `oversized layout accepted`);
});

await check('POST dedupes repeated cells', async () => {
  const r = await (await worker.fetch(postLayout('dup', { cells: [{ x: 4, z: 4 }, { x: 4, z: 4 }] }), env)).json();
  assert(r.cells.length === 1, `expected 1 cell, got ${r.cells.length}`);
});

await check('re-saving preserves createdAt but moves updatedAt', async () => {
  const first = await (await worker.fetch(postLayout('ts', good), env)).json();
  await new Promise(r => setTimeout(r, 5));
  const second = await (await worker.fetch(postLayout('ts', { cells: [{ x: 5, z: 5 }] }), env)).json();
  assert(second.createdAt === first.createdAt, 'createdAt was clobbered');
  assert(second.updatedAt >= first.updatedAt, 'updatedAt did not advance');
  assert(second.cells[0].x === 5, 'cells not replaced');
});

await check('ids with a colon cannot escape into another namespace', async () => {
  const r = await worker.fetch(postLayout('evil%3Amaze%3Ax', good), env);
  assert(r.status === 400, `colon id accepted: ${r.status}`);
});

await check('GET /layouts lists ids and cell counts', async () => {
  const { layouts } = await (await worker.fetch(req('/layouts?gameId=maze'), env)).json();
  const t1 = layouts.find(l => l.id === 't1');
  assert(t1, `t1 missing from ${JSON.stringify(layouts.map(l => l.id))}`);
  assert(t1.cells === 2, `cell count ${t1.cells}`);
});

await check('DELETE removes a layout and reports whether it existed', async () => {
  const d = await (await worker.fetch(req('/layouts/t1?gameId=maze', { method: 'DELETE' }), env)).json();
  assert(d.deleted === true, 'expected deleted:true');
  const again = await (await worker.fetch(req('/layouts/t1?gameId=maze', { method: 'DELETE' }), env)).json();
  assert(again.deleted === false, 'idempotent delete must report deleted:false');
  const gone = await worker.fetch(req('/layouts/t1?gameId=maze'), env);
  assert(gone.status === 404, `still readable: ${gone.status}`);
});

await check('wrong method on a layout id is 405 with an Allow header', async () => {
  const r = await worker.fetch(req('/layouts/t1', { method: 'PUT' }), env);
  assert(r.status === 405, `status ${r.status}`);
  assert((r.headers.get('Allow') || '').includes('DELETE'), 'Allow header missing DELETE');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
