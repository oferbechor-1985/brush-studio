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

// Common subjects for kids' coloring pages: translated directly (the translation model gets short Hebrew words wrong, e.g. a hippopotamus became "hypocrites").
const DICT = {
  'חתול':'cat','חתולים':'cats','חתולה':'cat','כלב':'dog','כלבים':'dogs','גור':'puppy','סוס':'horse','סוסים':'horses','פרה':'cow','כבשה':'sheep','ארנב':'rabbit','ארנבים':'rabbits',
  'דג':'fish','דגים':'fish','ציפור':'bird','ציפורים':'birds','פרפר':'butterfly','פרפרים':'butterflies','דבורה':'bee','נחש':'snake','צב':'turtle','צפרדע':'frog','פיל':'elephant',
  "ג'ירפה":'giraffe','אריה':'lion','נמר':'tiger','דוב':'bear','קוף':'monkey','זברה':'zebra','היפופוטם':'hippopotamus','היפופוטמים':'hippopotamuses','תנין':'crocodile',
  'דינוזאור':'dinosaur','דינוזאורים':'dinosaurs','דולפין':'dolphin','לוויתן':'whale','כריש':'shark','תמנון':'octopus','פינגווין':'penguin','ינשוף':'owl','ברווז':'duck','תרנגול':'rooster',
  'תרנגולת':'hen','חזיר':'pig','עז':'goat','חמור':'donkey','עכבר':'mouse','סנאי':'squirrel','זאב':'wolf','שועל':'fox','גמל':'camel','קנגורו':'kangaroo','פנדה':'panda','קואלה':'koala',
  'דרקון':'dragon','נשר':'eagle','תוכי':'parrot','חילזון':'snail','פרפר':'butterfly','חרק':'insect','עכביש':'spider','נמלה':'ant','קיפוד':'hedgehog','ג׳ירפה':'giraffe',
  'בלון':'balloon','בלונים':'balloons','מכונית':'car','אוטובוס':'bus','רכבת':'train','מטוס':'airplane','ספינה':'ship','סירה':'boat','אופניים':'bicycle','טרקטור':'tractor',
  'בית':'house','טירה':'castle','ארמון':'palace','עץ':'tree','עצים':'trees','פרח':'flower','פרחים':'flowers','שמש':'sun','ירח':'moon','כוכב':'star','כוכבים':'stars','ענן':'cloud',
  'גשם':'rain','קשת':'rainbow','הר':'mountain','הרים':'mountains','ים':'sea','מים':'water','נהר':'river','חוף':'beach','יער':'forest','גן':'garden','שדה':'field','לב':'heart',
  'עוגה':'cake','גלידה':'ice cream','תפוח':'apple','בננה':'banana','כובע':'hat','נעל':'shoe','ספר':'book','כדור':'ball','כדורגל':'soccer ball','חללית':'spaceship','רקטה':'rocket',
  'רובוט':'robot','פיה':'fairy','נסיכה':'princess','נסיך':'prince','מלך':'king','מלכה':'queen','פיראט':'pirate','ליצן':'clown','ילד':'boy','ילדה':'girl','ילדים':'children','תינוק':'baby',
  'אמא':'mother','אבא':'father','סבא':'grandfather','סבתא':'grandmother','יום':'day','הולדת':'birthday','חנוכה':'Hanukkah','חנוכיה':'Hanukkah menorah','פורים':'Purim','פסח':'Passover',
  'סוכה':'sukkah','אסתר':'Queen Esther','נח':'Noah','תיבה':'ark','מדבר':'desert','שלג':'snow','איש':'man','אישה':'woman','פיל':'elephant','בובה':'doll','דובי':'teddy bear',
  'עם':'with','על':'on','ליד':'next to','בתוך':'inside','מתחת':'under','מעל':'above','ו':'and','או':'or','של':'of','בים':'in the sea','במים':'in the water',
};
const PREFIX = { 'ב':'in', 'ל':'to', 'ה':'', 'ו':'and', 'מ':'from', 'כ':'like', 'ש':'' };
// returns { en: English text, unknown: [hebrew words we could not map] }
function dictTranslate(text) {
  const out = [], unknown = [];
  text = text.replace(/יום\s+הולדת/g, 'הולדת'); // "birthday" is two Hebrew words
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    const t = raw.replace(/[.,!?;:"()]+/g, '');
    if (!t) continue;
    if (!/[\u0590-\u05FF]/.test(t)) { out.push(t); continue; }
    if (DICT[t]) { out.push(DICT[t]); continue; }
    const p = t[0];
    if (p in PREFIX && DICT[t.slice(1)]) { if (PREFIX[p]) out.push(PREFIX[p]); out.push(DICT[t.slice(1)]); continue; }
    const p2 = t.slice(0, 2); // two prefixes, e.g. ובמים
    if (t.length > 3 && t[0] === 'ו' && t[1] in PREFIX && DICT[t.slice(2)]) { out.push('and'); if (PREFIX[t[1]]) out.push(PREFIX[t[1]]); out.push(DICT[t.slice(2)]); continue; }
    unknown.push(t); out.push('\u0000' + (unknown.length - 1));
  }
  return { parts: out, unknown };
}

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
    if (text.length < 2 && !(typeof b.en === 'string' && b.en.trim())) return reply({ error: 'empty' }, 400, cors);
    const detail = [1, 2, 3].includes(+b.detail) ? +b.detail : 2;

    // daily cap (needs the optional KV binding); the day changes at 00:00 UTC like Cloudflare's own allowance
    const max = Math.max(1, Math.min(150, +env.MAX_PER_DAY || 60));
    const key = 'n:' + new Date().toISOString().slice(0, 10);
    let used = 0;
    if (env.COUNTER) {
      used = +(await env.COUNTER.get(key)) || 0;
      if (used >= max) return reply({ error: 'cap', left: 0 }, 429, cors);
    }

    // Hebrew (or any non-English) request -> English, FLUX understands English best.
    // Two translators are tried; if both fail we stop, because FLUX would draw something unrelated from Hebrew text.
    let subject = text, via = 'none';
    const en = typeof b.en === 'string' ? b.en.trim().slice(0, 200) : '';
    if (en && !/[^\x00-\x7F]/.test(en)) { subject = en; via = 'user'; } // English typed or edited by the user: no translation
    else if (/[^\x00-\x7F]/.test(text)) {
      const errs = [];
      const clean = v => String(v || '').trim().replace(/^["'`]+|["'`.]+$/g, '').split('\n')[0].trim();
      const tr = async word => {
        let out = '';
        try {
          const r = await env.AI.run('@cf/meta/m2m100-1.2b', { text: word, source_lang: 'he', target_lang: 'en' });
          out = clean(r && (r.translated_text || (r.result && r.result.translated_text)));
          if (out) via = 'm2m';
        } catch (e) { errs.push('m2m:' + String((e && e.message) || e).slice(0, 80)); }
        if (!out || /[\u0590-\u05FF]/.test(out)) {
          out = '';
          try {
            const r = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
              messages: [
                { role: 'system', content: 'Translate the Hebrew text to English literally. It is part of a request to draw something. Output only the English translation, no quotes, no explanations.' },
                { role: 'user', content: word },
              ],
              max_tokens: 40,
            });
            out = clean(r && (typeof r === 'string' ? r : (r.response || (r.result && r.result.response))));
            if (out) via = 'llama';
          } catch (e) { errs.push('llama:' + String((e && e.message) || e).slice(0, 80)); }
        }
        return out;
      };
      const d = dictTranslate(text);
      let failed = false;
      const words = [];
      for (const w of d.unknown.slice(0, 8)) { const o = await tr(w); if (!o || /[\u0590-\u05FF]/.test(o)) failed = true; words.push(o || ''); }
      if (d.unknown.length > 8) failed = true;
      if (!d.unknown.length) via = 'dict';
      const out = failed ? '' : d.parts.map(x => x.startsWith('\u0000') ? words[+x.slice(1)] : x).join(' ').replace(/\s+/g, ' ').trim();
      if (!out || out.length > 200 || /[\u0590-\u05FF]/.test(out)) return reply({ error: 'tr', msg: errs.join(' | ') || 'empty' }, 502, cors);
      subject = out;
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
    return reply({ ok: true, image: 'data:image/jpeg;base64,' + img, left: env.COUNTER ? max - used : null, en: subject, via }, 200, cors);
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
