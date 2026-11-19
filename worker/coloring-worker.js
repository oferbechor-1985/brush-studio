// OBPaint coloring-page maker (Cloudflare Worker + Workers AI, free plan).
// The app sends a request; this worker asks FLUX.1 schnell for a black-and-white line drawing and returns it.
// Setup (Cloudflare dashboard):
//   1. Workers & Pages > Create > Create Worker, paste this file, Deploy.
//   2. Settings > Bindings > Add > Workers AI, Variable name:  AI
//   3. (optional, recommended) Settings > Bindings > Add > KV namespace, Variable name:  COUNTER  (daily cap)
//   4. Settings > Variables and Secrets:
//        ACCESS_CODE    (secret)  your personal code, at least 8 characters; typed once in the app
//        ALLOWED_ORIGIN (text)    https://oferbechor-1985.github.io
//        MAX_PER_DAY    (text, optional)  default 60
// On the free plan, going over Cloudflare's daily free allowance only makes calls fail; nothing is charged.

const DETAIL = {
  1: 'very simple shapes, very few details, extra thick outlines, for toddlers',
  2: 'simple clear shapes, thick outlines, a few details, for young children',
  3: 'detailed intricate line work, medium outlines, rich patterns, for teenagers',
};

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
    if (req.method !== 'POST') return new Response('OBPaint coloring endpoint', { status: 200, headers: cors });
    if (!allowed.includes(origin)) return reply({ error: 'origin' }, 403, cors);
    if (!env.AI || !env.ACCESS_CODE || String(env.ACCESS_CODE).length < 8) return reply({ error: 'setup' }, 500, cors);

    let b;
    try { b = await req.json(); } catch (_) { return reply({ error: 'json' }, 400, cors); }
    if (!same(String(b.code || ''), String(env.ACCESS_CODE))) return reply({ error: 'code' }, 401, cors);
    const text = String(b.prompt || '').trim().slice(0, 200);
    if (text.length < 2) return reply({ error: 'empty' }, 400, cors);
    const detail = [1, 2, 3].includes(+b.detail) ? +b.detail : 2;

    // daily cap (needs the optional KV binding); the day changes at 00:00 UTC like Cloudflare's own allowance
    const max = Math.max(1, Math.min(150, +env.MAX_PER_DAY || 60));
    const key = 'n:' + new Date().toISOString().slice(0, 10);
    let used = 0;
    if (env.COUNTER) {
      used = +(await env.COUNTER.get(key)) || 0;
      if (used >= max) return reply({ error: 'cap', left: 0 }, 429, cors);
    }

    // Hebrew (or any non-English) request -> English, FLUX understands English best
    let subject = text;
    if (/[^\x00-\x7F]/.test(text)) {
      try {
        const t = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
          messages: [
            { role: 'system', content: 'Translate the user text from Hebrew to English literally and completely. Keep every animal, object, clothing item and action exactly as written (for example the Hebrew word for dinosaur must become "dinosaur"). Output only the English translation, no quotes, no explanations.' },
            { role: 'user', content: text },
          ],
          max_tokens: 60,
        });
        const out = String((t && t.response) || '').trim().replace(/^["']|["']$/g, '');
        if (out && out.length < 200) subject = out;
      } catch (_) { /* keep the original text */ }
    }
    const prompt = `${subject}, drawn exactly as described, the main subject is clearly recognizable. Coloring book page, black outlines only on a pure white background, ${DETAIL[detail]}, clean closed line art, no shading, no gray, no fill, no text, no watermark.`;

    let img;
    try {
      const r = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', { prompt, steps: 4 });
      img = r && r.image;
    } catch (e) {
      return reply({ error: 'ai', msg: String((e && e.message) || e).slice(0, 120) }, 502, cors);
    }
    if (!img) return reply({ error: 'ai' }, 502, cors);
    if (env.COUNTER) { used++; await env.COUNTER.put(key, String(used), { expirationTtl: 172800 }); }
    return reply({ ok: true, image: 'data:image/jpeg;base64,' + img, left: env.COUNTER ? max - used : null, en: subject }, 200, cors);
  },
};

function same(a, b) { // constant-time compare
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function reply(o, status, cors) {
  return new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
}
