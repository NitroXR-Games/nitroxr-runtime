import { SEED_ASSETS } from './registry.seed.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
  const base = assetBase(env);
  return {
    ...seed,
    glb_url: seed.glb_url ? seed.glb_url.replace('{{ASSET_BASE}}', base) : null,
    texture_url: seed.texture_url ? seed.texture_url.replace('{{ASSET_BASE}}', base) : null
  };
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
      const assets = { ...SEED_ASSETS };
      try {
        const { keys } = await store.list({ prefix: 'asset:' });
        for (const { name } of keys) {
          const raw = await store.get(name);
          if (!raw) continue;
          try {
            const entry = JSON.parse(raw);
            if (entry && entry.id) assets[entry.id] = entry;
          } catch { /* skip corrupt entries */ }
        }
      } catch { /* KV list unavailable: seeds only */ }
      return json({ assets: Object.values(assets).map(a => resolveSeed(a.id, env) || a) });
    }

    if (request.method === 'GET' && path.startsWith('/assets/')) {
      const id = decodeURIComponent(path.slice('/assets/'.length));
      if (!id) return json({ error: 'Asset id required' }, 400);
      const raw = await store.get(`asset:${id}`);
      if (raw) {
        try {
          return json(JSON.parse(raw));
        } catch {
          return json({ error: 'Corrupt registry entry', id }, 500);
        }
      }
      const seed = resolveSeed(id, env);
      if (seed) return json(seed);
      return json({ error: 'Asset not found', id }, 404);
    }

    if (path === '/assets') {
      if (request.method !== 'POST') return methodNotAllowed('GET, POST');
      const body = await readJson(request);
      if (!body || typeof body.id !== 'string' || !body.id) {
        return json({ error: 'Body must include a string `id`' }, 400);
      }
      const entry = {
        type: body.type || 'model',
        glb_url: body.glb_url || body.model_url || null,
        texture_url: body.texture_url || null,
        properties: body.properties || {},
        priority: body.priority ?? 4,
        description: body.description || '',
        version: body.version || '1.0.0',
        updated_at: new Date().toISOString(),
        id: body.id
      };
      await store.put(`asset:${body.id}`, JSON.stringify(entry));
      return json(entry, 201);
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
      const record = { userId, gameId, value, at: new Date().toISOString() };
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
      records.sort((a, b) => (b.value || 0) - (a.value || 0));
      return json({ gameId, scores: records.slice(0, limit) });
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

    if (request.method === 'GET' && (path === '/' || path === '')) {
      return new Response('NitroXR Cloud Body Active', { status: 200, headers: CORS });
    }

    return json({ error: 'Not found', path }, 404);
  }
};
