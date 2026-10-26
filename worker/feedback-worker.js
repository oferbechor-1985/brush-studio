// Brush Studio feedback receiver (Cloudflare Worker).
// Each comment is saved as one JSON file under inbox/ in a PRIVATE GitHub repo.
// Settings (Cloudflare dashboard > Worker > Settings > Variables and Secrets):
//   GITHUB_TOKEN   (secret)  fine-grained token, only the feedback repo, permission "Contents: Read and write"
//   REPO           (text)    for example  oferbechor-1985/brush-studio-feedback
//   ALLOWED_ORIGIN (text)    https://oferbechor-1985.github.io

const KINDS = ['idea', 'bug', 'other'];

export default {
  async fetch(req, env) {
    const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : (allowed[0] || ''),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return new Response('Brush Studio feedback endpoint', { status: 200, headers: cors });
    if (!allowed.includes(origin)) return reply({ error: 'origin' }, 403, cors);

    let b;
    try { b = await req.json(); } catch (_) { return reply({ error: 'json' }, 400, cors); }
    if (b && b.website) return reply({ ok: true }, 200, cors); // honeypot field, filled only by bots

    const text = String((b && b.text) || '').trim().slice(0, 1500);
    if (text.length < 3) return reply({ error: 'empty' }, 400, cors);

    const now = new Date();
    const id = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + crypto.randomUUID().slice(0, 6);
    const item = {
      id,
      at: now.toISOString(),
      kind: KINDS.includes(b.kind) ? b.kind : 'other',
      text,
      voice: !!b.voice,
      version: String(b.version || '').slice(0, 10),
      input: String(b.input || '').slice(0, 20),
      screen: String(b.screen || '').slice(0, 20),
      lang: String(b.lang || '').slice(0, 10),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(item, null, 2));
    let bin = '';
    for (const c of bytes) bin += String.fromCharCode(c);

    const res = await fetch(`https://api.github.com/repos/${env.REPO}/contents/inbox/${id}.json`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'brush-studio-feedback',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: `feedback ${id}`, content: btoa(bin) }),
    });
    if (!res.ok) return reply({ error: 'store' }, 502, cors);
    return reply({ ok: true, id }, 200, cors);
  },
};

function reply(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}
