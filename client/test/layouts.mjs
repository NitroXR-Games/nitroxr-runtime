import { Cloud } from '../src/index.js';

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`ok: ${name}`); }
  catch (e) { fail++; console.error(`FAIL: ${name}: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const realFetch = globalThis.fetch;
const realEndpoint = Cloud.endpoint;

// Installs a fake Cloud Body. `routes` maps "METHOD /path" -> [status, body].
function mockCloud(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    const key = `${method} ${u.pathname}${u.search}`;
    calls.push({ key, url, opts, method });
    const hit = routes[key];
    if (!hit) return new Response(JSON.stringify({ error: 'no route' }), { status: 404 });
    const [status, body] = hit;
    return new Response(JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json' }
    });
  };
  return calls;
}
function teardown() { globalThis.fetch = realFetch; Cloud.endpoint = realEndpoint; }

await check('saveLayout POSTs the cells and returns the record', async () => {
  const calls = mockCloud({ 'POST /layouts/my-maze?gameId=maze': [201, { id: 'my-maze', cells: [{ x: 1, z: 2 }] }] });
  try {
    const rec = await Cloud.saveLayout('my-maze', [{ x: 1, z: 2 }]);
    assert(rec.id === 'my-maze', `unexpected record ${JSON.stringify(rec)}`);
    assert(calls.length === 1 && calls[0].method === 'POST', 'expected exactly one POST');
    const sent = JSON.parse(calls[0].opts.body);
    assert(Array.isArray(sent.cells) && sent.cells[0].x === 1, `body was ${calls[0].opts.body}`);
  } finally { teardown(); }
});

await check('saveLayout throws with the server message on 400', async () => {
  mockCloud({ 'POST /layouts/bad?gameId=maze': [400, { error: 'Cell out of range 0..255: {x: 1e9, z: 0}' }] });
  try {
    let msg = '';
    try { await Cloud.saveLayout('bad', [{ x: 1e9, z: 0 }]); }
    catch (e) { msg = e.message; }
    // A swallowed failure here would silently lose the player's layout.
    assert(/out of range/i.test(msg), `expected the server reason, got "${msg}"`);
  } finally { teardown(); }
});

await check('getLayout returns the cells from the wrapped record', async () => {
  mockCloud({ 'GET /layouts/my-maze?gameId=maze': [200, { id: 'my-maze', cells: [{ x: 3, z: 4 }], updatedAt: 'now' }] });
  try {
    const cells = await Cloud.getLayout('my-maze');
    assert(Array.isArray(cells) && cells[0].z === 4, `expected cells, got ${JSON.stringify(cells)}`);
  } finally { teardown(); }
});

await check('getLayout returns null on 404 so the caller can fall back to local', async () => {
  mockCloud({});
  try {
    const r = await Cloud.getLayout('absent');
    assert(r === null, `expected null for a missing layout, got ${JSON.stringify(r)}`);
  } finally { teardown(); }
});

await check('getLayout throws on a 500 rather than pretending it is absent', async () => {
  mockCloud({ 'GET /layouts/boom?gameId=maze': [500, { error: 'Corrupt layout record' }] });
  try {
    let threw = false;
    try { await Cloud.getLayout('boom'); } catch { threw = true; }
    // Collapsing 500 into null would make the caller silently use stale local data.
    assert(threw, 'a server error must not look like "not found"');
  } finally { teardown(); }
});

await check('a record with no cells yields null instead of a broken layout', async () => {
  mockCloud({ 'GET /layouts/weird?gameId=maze': [200, { id: 'weird' }] });
  try {
    const r = await Cloud.getLayout('weird');
    assert(r === null, `expected null, got ${JSON.stringify(r)}`);
  } finally { teardown(); }
});

await check('layout ids are URL-encoded', async () => {
  const calls = mockCloud({});
  try {
    await Cloud.getLayout('my maze/v2');
    assert(calls[0].url.includes('my%20maze%2Fv2'), `id was not encoded: ${calls[0].url}`);
  } finally { teardown(); }
});

await check('listLayouts degrades to an empty list on error', async () => {
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    const r = await Cloud.listLayouts();
    assert(Array.isArray(r.layouts) && r.layouts.length === 0, 'a network error must not throw here');
  } finally { teardown(); }
});

await check('deleteLayout sends DELETE and reports the result', async () => {
  const calls = mockCloud({ 'DELETE /layouts/gone?gameId=maze': [200, { deleted: true, id: 'gone' }] });
  try {
    const r = await Cloud.deleteLayout('gone');
    assert(r.deleted === true, `unexpected ${JSON.stringify(r)}`);
    assert(calls[0].method === 'DELETE', `method was ${calls[0].method}`);
  } finally { teardown(); }
});

await check('layout calls honour a redirected endpoint', async () => {
  const calls = mockCloud({ 'POST /layouts/x?gameId=maze': [201, { id: 'x', cells: [] }] });
  try {
    Cloud.setEndpoint('https://staging.example.com');
    await Cloud.saveLayout('x', []);
    assert(calls[0].url.startsWith('https://staging.example.com/'), `went to ${calls[0].url}`);
  } finally { teardown(); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
