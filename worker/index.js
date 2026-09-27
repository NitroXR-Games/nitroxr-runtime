export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/submit') {
      const data = await request.json();
      // Store in KV
      await env.NITRO_KV.put(`score:${data.userId}`, data.value);
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (path.startsWith('/ghost/')) {
      const userId = path.split('/')[2];
      const ghost = await env.NITRO_KV.get(`ghost:${userId}`);
      return new Response(ghost || JSON.stringify({ error: 'Not found' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('NitroXR Cloud Body Active', { status: 200 });
  }
};
