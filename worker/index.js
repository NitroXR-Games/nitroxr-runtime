import { SEED_ASSETS } from './registry.seed.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}

function methodNotAllowed(allow) {
  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json', Allow: allow, ...CORS }
  });
}

// In-memory KV fallback for `wrangler dev` without bindings and for node tests.
function kv(env) {
  if (env && env.NITRO_KV) return env.NITRO_KV;
  if (!globalThis.__NITRO_MEM_KV) {
    const store = new Map();
    globalThis.__NITRO_MEM_KV = {
      async get(k) { return store.has(k) ? store.get(k) : null; },
      async put(k, v) { store.set(k, v); },
      async delete(k) { store.delete(k); },
      async list({ prefix } = {}) {
        const keys = [];
        for (const name of store.keys()) {
          if (!prefix || name.startsWith(prefix)) keys.push({ name });
        }
        return { keys };
      }
    };
  }
  return globalThis.__NITRO_MEM_KV;
}

function assetBase(env) {
  return (env && env.ASSET_BASE_URL) || 'https://assets.nitroxr.io';
}

function resolveSeed(id, env) {
  const seed = SEED_ASSETS[id];
  if (!seed) return null;
  return templateEntry(seed, assetBase(env));
}

// Expands {{ASSET_BASE}} in every URL field. Applied to seeds AND to entries
// read back from KV, so a registered asset behaves exactly like a seeded one.
function templateEntry(entry, base) {
  const sub = (v) => (typeof v === 'string' ? v.replace('{{ASSET_BASE}}', base) : v ?? null);
  return {
    ...entry,
    glb_url: sub(entry.glb_url),
    texture_url: sub(entry.texture_url),
    audio_url: sub(entry.audio_url)
  };
}

// Lap 7 layout guardrails. Cells are fed straight into the client's
// addWall(x, z), so an unvalidated {x: 1e9} places a wall kilometres away and a
// 1e6-element array locks the main thread. The /ghost/ endpoint validates
// nothing; layouts are user-authored and replayed, so they get checked.
const MAX_LAYOUT_CELLS = 2000;
const MAX_CELL_COORD = 255;

function validateCells(cells) {
  if (!Array.isArray(cells)) {
    return { error: 'Body must include `cells`: an array of {x, z} wall positions' };
  }
  if (cells.length === 0) return { error: 'A layout needs at least one wall cell' };
  if (cells.length > MAX_LAYOUT_CELLS) {
    return { error: `A layout may hold at most ${MAX_LAYOUT_CELLS} cells, got ${cells.length}` };
  }
  const seen = new Set();
  const clean = [];
  for (const c of cells) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      return { error: `Each cell must be an object {x, z}, got ${JSON.stringify(c)}` };
    }
    const { x, z } = c;
    if (!Number.isInteger(x) || !Number.isInteger(z)) {
      return { error: `Cell coordinates must be integers, got ${JSON.stringify(c)}` };
    }
    if (x < 0 || x > MAX_CELL_COORD || z < 0 || z > MAX_CELL_COORD) {
      return { error: `Cell out of range 0..${MAX_CELL_COORD}: {x: ${x}, z: ${z}}` };
    }
    // Duplicates are deduped rather than rejected: a re-saved layout should not
    // fail just because a client appended the same wall twice.
    const k = `${x},${z}`;
    if (seen.has(k)) continue;
    seen.add(k);
    clean.push({ x, z });
  }
  return { cells: clean };
}

// KV keys are built as `${prefix}:${gameId}:${id}`, so an id containing a colon
// would let a caller write into another game's namespace. Restrict to a slug.
function validSegment(v) {
  return typeof v === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(v);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const store = kv(env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method === 'GET' && path === '/health') {
      return json({ ok: true, service: 'nitroxr-runtime-worker', time: new Date().toISOString() });
    }

    // ---- Asset registry ----
    if (request.method === 'GET' && path === '/assets') {
      const base = assetBase(env);
      const assets = {};
      // KV entries win over seeds, matching GET /assets/:id.
      try {
        const { keys } = await store.list({ prefix: 'asset:' });
        for (const { name } of keys) {
          const raw = await store.get(name);
          if (!raw) continue;
          try {
            const entry = JSON.parse(raw);
            if (entry && entry.id) assets[entry.id] = templateEntry(entry, base);
          } catch { /* skip corrupt entries */ }
        }
      } catch { /* KV list unavailable: seeds only */ }
      // Only seed ids that were NOT overridden above.
      for (const [id, seed] of Object.entries(SEED_ASSETS)) {
        if (!(id in assets)) assets[id] = templateEntry(seed, base);
      }
      return json({ assets: Object.values(assets) });
    }

    if (request.method === 'GET' && path.startsWith('/assets/')) {
      const id = decodeURIComponent(path.slice('/assets/'.length));
      if (!id) return json({ error: 'Asset id required' }, 400);
      const base = assetBase(env);
      const raw = await store.get(`asset:${id}`);
      if (raw) {
        try {
          return json(templateEntry(JSON.parse(raw), base));
        } catch {
          return json({ error: 'Corrupt registry entry', id }, 500);
        }
      }
      const seed = resolveSeed(id, env);
      if (seed) return json(seed);
      return json({ error: 'Asset not found', id }, 404);
    }

    // Remove an override and fall back to the seed. Without this a registered
    // asset shadows its seed forever with no way back.
    if (request.method === 'DELETE' && path.startsWith('/assets/')) {
      const id = decodeURIComponent(path.slice('/assets/'.length));
      if (!id) return json({ error: 'Asset id required' }, 400);
      await store.delete(`asset:${id}`);
      return json({ deleted: true, id, seeded: !!SEED_ASSETS[id] });
    }

    if (path === '/assets') {
      if (request.method !== 'POST') return methodNotAllowed('GET, POST');
      const body = await readJson(request);
      if (!body || typeof body.id !== 'string' || !body.id) {
        return json({ error: 'Body must include a string `id`' }, 400);
      }
      const entry = {
        type: body.type || 'model',
        org: body.org || 'nitroxr-games',
        game: body.game || body.gameId || 'maze',
        glb_url: body.glb_url || body.model_url || null,
        texture_url: body.texture_url || null,
        // Was silently dropped, making audio second-class: the only way to
        // register it was editing the seed file and redeploying the Worker.
        audio_url: body.audio_url || null,
        properties: body.properties || {},
        priority: body.priority ?? 4,
        description: body.description || '',
        version: body.version || '1.0.0',
        updated_at: new Date().toISOString(),
        id: body.id
      };
      await store.put(`asset:${body.id}`, JSON.stringify(entry));
      return json(templateEntry(entry, assetBase(env)), 201);
    }

    // ---- Scores / leaderboard ----
    if (path === '/submit') {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const body = await readJson(request);
      const userId = body && body.userId;
      const value = body && (body.value ?? body.score);
      if (!userId || typeof value !== 'number') {
        return json({ error: 'Body must include `userId` (string) and `value` (number)' }, 400);
      }
      const gameId = body.gameId || 'maze';
      // `steps` is display-only metadata; it must never influence `value`.
      const record = {
        userId, gameId, value, at: new Date().toISOString(),
        ...(Number.isFinite(body.steps) ? { steps: body.steps } : {})
      };
      await store.put(`score:${gameId}:${userId}`, JSON.stringify(record));
      return json({ success: true, ...record });
    }

    if (request.method === 'GET' && path.startsWith('/leaderboard/')) {
      const gameId = decodeURIComponent(path.slice('/leaderboard/'.length)) || 'maze';
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10) || 10, 100);
      let records = [];
      try {
        const { keys } = await store.list({ prefix: `score:${gameId}:` });
        for (const { name } of keys.slice(0, 1000)) {
          const raw = await store.get(name);
          if (!raw) continue;
          try { records.push(JSON.parse(raw)); } catch { /* skip */ }
        }
      } catch {
        return json({ gameId, scores: [] });
      }
      // `order=asc` is additive and defaults to the historical descending
      // sort, so existing consumers are unaffected. A time-trial game needs it:
      // its score IS the elapsed run time, where fewer seconds must win.
      const order = (url.searchParams.get('order') || 'desc').toLowerCase();
      const dir = order === 'asc' ? 1 : -1;
      records.sort((a, b) => dir * ((a.value || 0) - (b.value || 0)));
      return json({ gameId, order: dir === 1 ? 'asc' : 'desc', scores: records.slice(0, limit) });
    }

    // ---- Ghost paths ----
    if (path.startsWith('/ghost/')) {
      const userId = decodeURIComponent(path.slice('/ghost/'.length));
      if (!userId) return json({ error: 'userId required' }, 400);
      const gameId = url.searchParams.get('gameId') || 'maze';
      if (request.method === 'GET') {
        const scoped = await store.get(`ghost:${gameId}:${userId}`);
        if (scoped) {
          try { return json(JSON.parse(scoped)); } catch { /* fall through */ }
        }
        const legacy = await store.get(`ghost:${userId}`);
        if (legacy) {
          try { return json(JSON.parse(legacy)); } catch { /* fall through */ }
        }
        return json({ error: 'Ghost not found', userId, gameId }, 404);
      }
      if (request.method === 'POST') {
        const body = await readJson(request);
        const pathData = body && (body.path || body.points || body.positions);
        if (!pathData) {
          return json({ error: 'Body must include `path` (array of positions)' }, 400);
        }
        const record = { userId, gameId, path: pathData, at: new Date().toISOString() };
        await store.put(`ghost:${gameId}:${userId}`, JSON.stringify(record));
        return json({ success: true, ...record }, 201);
      }
      return methodNotAllowed('GET, POST');
    }

    // Lap 7: user-authored maze layouts. Mirrors the /ghost/ convention - a
    // keyed JSON blob scoped by gameId - so layouts survive the browser that
    // made them, which is the whole point (localStorage dies with the profile).
    if (path === '/layouts' && request.method === 'GET') {
      const gameId = url.searchParams.get('gameId') || 'maze';
      if (!validSegment(gameId)) return json({ error: 'Invalid gameId' }, 400);
      const prefix = `layout:${gameId}:`;
      const { keys } = await store.list({ prefix });
      const layouts = [];
      for (const k of keys) {
        const raw = await store.get(k.name);
        if (!raw) continue;
        try {
          const rec = JSON.parse(raw);
          layouts.push({
            id: k.name.slice(prefix.length),
            cells: Array.isArray(rec.cells) ? rec.cells.length : 0,
            updatedAt: rec.updatedAt || null
          });
        } catch { /* skip corrupt entry rather than failing the whole list */ }
      }
      return json({ layouts });
    }

    if (path.startsWith('/layouts/')) {
      const id = decodeURIComponent(path.slice('/layouts/'.length)).trim();
      if (!id) return json({ error: 'Layout id required' }, 400);
      if (!validSegment(id)) {
        return json({ error: 'Layout id must be 1-64 chars of A-Z a-z 0-9 . _ -' }, 400);
      }
      const gameId = url.searchParams.get('gameId') || 'maze';
      if (!validSegment(gameId)) return json({ error: 'Invalid gameId' }, 400);
      const key = `layout:${gameId}:${id}`;

      if (request.method === 'GET') {
        const raw = await store.get(key);
        if (!raw) return json({ error: 'Layout not found', id, gameId }, 404);
        try {
          return json(JSON.parse(raw));
        } catch {
          return json({ error: 'Corrupt layout record', id }, 500);
        }
      }

      if (request.method === 'POST') {
        const body = await readJson(request);
        const v = validateCells(body && body.cells);
        if (v.error) return json({ error: v.error, id, gameId }, 400);
        const record = {
          id, gameId, cells: v.cells, version: 1,
          createdAt: (body && body.createdAt) || new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        const existing = await store.get(key);
        if (existing) {
          try { record.createdAt = JSON.parse(existing).createdAt || record.createdAt; } catch { /* keep new */ }
        }
        await store.put(key, JSON.stringify(record));
        return json(record, 201);
      }

      if (request.method === 'DELETE') {
        const existed = !!(await store.get(key));
        await store.delete(key);
        return json({ deleted: existed, id, gameId });
      }

      return methodNotAllowed('GET, POST, DELETE');
    }

    if (request.method === 'GET' && (path === '/' || path === '')) {
      return new Response('NitroXR Cloud Body Active', { status: 200, headers: CORS });
    }

    return json({ error: 'Not found', path }, 404);
  }
};
