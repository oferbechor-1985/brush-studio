// OBPaint shared folder (Cloudflare Worker + KV).
// Anyone who has the access code can list, upload, download and delete their own files.
// Setup (Cloudflare dashboard):
//   1. Storage & Databases > KV > Create namespace, e.g. "obpaint-gallery"
//   2. Workers & Pages > Create > Worker, paste this file, Deploy
//   3. Worker > Settings > Bindings > Add > KV namespace: variable name  GALLERY  -> the namespace from step 1
//   4. Worker > Settings > Variables and Secrets:
//        ACCESS_CODE    (secret)  the code you give to the group, 8+ characters
//        ADMIN_CODE     (secret)  optional, lets you delete any file
//        ALLOWED_ORIGIN (text)    https://oferbechor-1985.github.io
// "Protect with Cloudflare Access" must stay OFF for this worker.

const MAX_BYTES = 24 * 1024 * 1024; // KV values are limited to 25 MiB

export default {
  async fetch(req, env) {
    const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : (allowed[0] || ''),
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Code, X-Name, X-By, X-Device, X-Admin',
      'Vary': 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!allowed.includes(origin)) return reply({ error: 'origin' }, 403, cors);

    const code = req.headers.get('X-Code') || '';
    if (!env.ACCESS_CODE || !same(code, env.ACCESS_CODE)) {
      await new Promise(r => setTimeout(r, 400)); // slows down guessing
      return reply({ error: 'code' }, 401, cors);
    }
    const dev = clean(req.headers.get('X-Device'), 40);
    const admin = !!env.ADMIN_CODE && same(req.headers.get('X-Admin') || '', env.ADMIN_CODE);
    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/list') {
      const out = [];
      let cursor;
      do {
        const r = await env.GALLERY.list({ prefix: 'f:', cursor, limit: 1000 });
        for (const k of r.keys) {
          const m = k.metadata || {};
          out.push({ id: k.name.slice(2), name: m.name || '', by: m.by || '', at: m.at || '', size: m.size || 0, mine: !!dev && m.dev === dev });
        }
        cursor = r.list_complete ? null : r.cursor;
      } while (cursor);
      out.sort((a, b) => (a.at < b.at ? 1 : -1));
      return reply({ files: out, admin }, 200, cors);
    }

    if (req.method === 'POST' && url.pathname === '/file') {
      const len = +(req.headers.get('Content-Length') || 0);
      if (len > MAX_BYTES) return reply({ error: 'size' }, 413, cors);
      const body = await req.text();
      if (body.length > MAX_BYTES) return reply({ error: 'size' }, 413, cors);
      if (!body.startsWith('{"app":"OBPaint"')) return reply({ error: 'format' }, 400, cors);
      const id = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + crypto.randomUUID().slice(0, 6);
      const meta = {
        name: dec(req.headers.get('X-Name'), 80) || 'ללא שם',
        by: dec(req.headers.get('X-By'), 30) || 'אנונימי',
        at: new Date().toISOString(),
        size: body.length,
        dev,
      };
      await env.GALLERY.put('f:' + id, body, { metadata: meta });
      return reply({ ok: true, id }, 200, cors);
    }

    const m = url.pathname.match(/^\/file\/([0-9]{14}-[0-9a-f]{6})$/);
    if (m && req.method === 'GET') {
      const v = await env.GALLERY.get('f:' + m[1], 'stream');
      if (!v) return reply({ error: 'missing' }, 404, cors);
      return new Response(v, { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    if (m && req.method === 'DELETE') {
      const r = await env.GALLERY.getWithMetadata('f:' + m[1], 'stream');
      if (!r.value) return reply({ error: 'missing' }, 404, cors);
      if (!admin && !(dev && r.metadata && r.metadata.dev === dev)) return reply({ error: 'owner' }, 403, cors);
      await env.GALLERY.delete('f:' + m[1]);
      return reply({ ok: true }, 200, cors);
    }
    return reply({ error: 'route' }, 404, cors);
  },
};

function same(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}
function clean(s, n) { return String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, n); }
function dec(s, n) { try { return decodeURIComponent(String(s || '')).replace(/[\u0000-\u001f]/g, '').trim().slice(0, n); } catch (_) { return ''; } }
function reply(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}
