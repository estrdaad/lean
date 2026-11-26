/**
 * Zero-cost Cloudflare Worker proxy for:
 *  - POST /tts     -> Google Cloud Text-to-Speech (Chirp 3: HD, ar-XA)
 *  - POST /discuss -> Google AI Studio Gemini API (Free Tier)
 *
 * Enforces hard monthly/daily caps (in KV if bound, or per-isolate memory fallback),
 * caches MP3 responses on Cloudflare Edge Cache, and locks down CORS origins.
 */

const SAFE_MONTHLY_CHARS = 900000; // < 1,000,000 Chirp 3 HD free monthly tier
const SAFE_DAILY_CHARS = 30000;
const SAFE_GEMINI_DAILY_REQ = 20;
const SAFE_GEMINI_TTS_DAILY_REQ = 15;
const MAX_TTS_TEXT_CHARS = 700;
const ALLOWED_GEMINI_VOICES = new Set(['Charon', 'Orus', 'Fenrir', 'Aoede', 'Kore', 'Leda']);
const ALLOWED_VOICES = new Set([
  'ar-XA-Chirp3-HD-Charon',
  'ar-XA-Chirp3-HD-Orus',
  'ar-XA-Chirp3-HD-Fenrir',
  'ar-XA-Chirp3-HD-Aoede',
  'ar-XA-Chirp3-HD-Kore',
  'ar-XA-Chirp3-HD-Leda'
]);
const ALLOWED_MODELS = new Set([
  'gemini-flash-lite-latest',
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash'
]);

const memQuota = new Map();

function utcMonthKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function utcDayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function getCounter(env, key) {
  if (env.QUOTA_KV) {
    const val = await env.QUOTA_KV.get(key);
    return Number(val) || 0;
  }
  return memQuota.get(key) || 0;
}

async function addCounter(env, key, delta, ttlSeconds) {
  const next = (await getCounter(env, key)) + delta;
  if (env.QUOTA_KV) {
    await env.QUOTA_KV.put(key, String(next), { expirationTtl: ttlSeconds });
  } else {
    memQuota.set(key, next);
  }
  return next;
}

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || 'https://estrdaad.github.io,http://localhost:8087,http://127.0.0.1:8087')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const matched = allowed.includes(origin) ? origin : allowed[0];
  return {
    'access-control-allow-origin': matched,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'vary': 'origin'
  };
}

function jsonResp(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
  });
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function handleTts(request, env, cors) {
  if (!env.GOOGLE_TTS_API_KEY) {
    return jsonResp({ error: 'GOOGLE_TTS_API_KEY secret is not configured.' }, 503, cors);
  }
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON.' }, 400, cors); }

  const text = String(body.text || '').trim();
  if (!text || text.length > MAX_TTS_TEXT_CHARS) {
    return jsonResp({ error: `Text must be 1..${MAX_TTS_TEXT_CHARS} characters.` }, 400, cors);
  }
  const voice = ALLOWED_VOICES.has(body.voice) ? body.voice : 'ar-XA-Chirp3-HD-Charon';
  const speakingRate = Math.min(1.6, Math.max(0.75, Number(body.speakingRate) || 1.0));

  // Check Cloudflare Edge Cache first (0 characters spent on cache hit!)
  const cacheKeyHash = await sha256Hex(`${voice}|${speakingRate.toFixed(2)}|${text}`);
  const cacheUrl = new Request(`https://tts-cache.local/${cacheKeyHash}.mp3`);
  const edgeCache = typeof caches !== 'undefined' ? caches.default : null;
  if (edgeCache) {
    const cached = await edgeCache.match(cacheUrl);
    if (cached) {
      const h = new Headers(cached.headers);
      Object.entries(cors).forEach(([k, v]) => h.set(k, v));
      h.set('x-cache', 'HIT');
      return new Response(cached.body, { status: 200, headers: h });
    }
  }

  // Enforce hard $0.00/month limits BEFORE calling Google
  const monthKey = `tts:m:${utcMonthKey()}`;
  const dayKey = `tts:d:${utcDayKey()}`;
  const monthlyCap = Math.min(SAFE_MONTHLY_CHARS, Number(env.CHIRP_MONTHLY_CAP) || SAFE_MONTHLY_CHARS);
  const dailyCap = Math.min(monthlyCap, Number(env.CHIRP_DAILY_CAP) || SAFE_DAILY_CHARS);

  const [usedMonth, usedDay] = await Promise.all([getCounter(env, monthKey), getCounter(env, dayKey)]);
  if (usedMonth + text.length > monthlyCap) {
    return jsonResp({ error: 'Monthly zero-cost Chirp 3 HD cap reached.', remainingMonthly: Math.max(0, monthlyCap - usedMonth) }, 429, cors);
  }
  if (usedDay + text.length > dailyCap) {
    return jsonResp({ error: 'Daily zero-cost Chirp 3 HD cap reached.', remainingDaily: Math.max(0, dailyCap - usedDay) }, 429, cors);
  }

  const upstream = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(env.GOOGLE_TTS_API_KEY)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: 'ar-XA', name: voice },
        audioConfig: { audioEncoding: 'MP3', speakingRate }
      })
    }
  );
  if (!upstream.ok) {
    return jsonResp({ error: 'Upstream Google TTS error', status: upstream.status }, upstream.status, cors);
  }

  const data = await upstream.json();
  if (!data.audioContent) return jsonResp({ error: 'No audio returned.' }, 502, cors);

  await Promise.all([
    addCounter(env, monthKey, text.length, 35 * 86400),
    addCounter(env, dayKey, text.length, 2 * 86400)
  ]);

  const bin = atob(data.audioContent);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  const audioResp = new Response(bytes, {
    status: 200,
    headers: {
      'content-type': 'audio/mpeg',
      'cache-control': 'public, max-age=2592000',
      'x-cache': 'MISS',
      ...cors
    }
  });

  if (edgeCache) {
    await edgeCache.put(cacheUrl, audioResp.clone());
  }
  return audioResp;
}

export async function handleDiscuss(request, env, cors) {
  if (!env.GEMINI_API_KEY) {
    return jsonResp({ error: 'GEMINI_API_KEY secret is not configured.' }, 503, cors);
  }
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON.' }, 400, cors); }

  const payload = body.payload;
  if (!payload || !Array.isArray(payload.contents) || !payload.contents.length) {
    return jsonResp({ error: 'Invalid discussion payload.' }, 400, cors);
  }

  // Enforce hard daily request cap for Gemini Free Tier
  const dayKey = `gemini:d:${utcDayKey()}`;
  const dailyCap = Number(env.GEMINI_DAILY_CAP) || SAFE_GEMINI_DAILY_REQ;
  const usedDay = await getCounter(env, dayKey);
  if (usedDay >= dailyCap) {
    return jsonResp({ error: 'Daily free-tier Gemini discussion cap reached.' }, 429, cors);
  }

  // Enforce concise output cap server-side too
  const safePayload = {
    ...payload,
    generationConfig: {
      ...(payload.generationConfig || {}),
      maxOutputTokens: Math.min(520, Number(payload.generationConfig?.maxOutputTokens) || 320)
    }
  };

  const primaryModel = ALLOWED_MODELS.has(body.model) ? body.model : 'gemini-flash-lite-latest';
  const fallbackChain = [primaryModel, 'gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-3.8-flash']
    .filter((m, idx, arr) => arr.indexOf(m) === idx);

  let upstream = null;
  let text = '';
  for (const candidateModel of fallbackChain) {
    upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(candidateModel)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(safePayload)
      }
    );
    text = await upstream.text();
    if (upstream.ok) break;
    if (![404, 429, 500, 503].includes(upstream.status)) break;
  }
  if (!upstream || !upstream.ok) {
    return jsonResp({ error: 'Upstream Gemini error', status: upstream?.status || 502 }, upstream?.status || 502, cors);
  }

  await addCounter(env, dayKey, 1, 2 * 86400);
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors }
  });
}

export async function handleGeminiTts(request, env, cors) {
  if (!env.GEMINI_API_KEY) {
    return jsonResp({ error: 'GEMINI_API_KEY secret is not configured.' }, 503, cors);
  }
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON.' }, 400, cors); }

  const text = String(body.text || '').trim();
  if (!text || text.length > MAX_TTS_TEXT_CHARS) {
    return jsonResp({ error: `Text must be 1..${MAX_TTS_TEXT_CHARS} characters.` }, 400, cors);
  }
  const rawVoice = String(body.voice || 'Charon').replace(/^ar-XA-Chirp3-HD-/, '');
  const voiceName = ALLOWED_GEMINI_VOICES.has(rawVoice) ? rawVoice : 'Charon';

  const cacheKeyHash = await sha256Hex(`gemini-tts|${voiceName}|${text}`);
  const cacheUrl = new Request(`https://tts-cache.local/${cacheKeyHash}.wav`);
  const edgeCache = typeof caches !== 'undefined' ? caches.default : null;
  if (edgeCache) {
    const cached = await edgeCache.match(cacheUrl);
    if (cached) {
      const h = new Headers(cached.headers);
      Object.entries(cors).forEach(([k, v]) => h.set(k, v));
      h.set('x-cache', 'HIT');
      return new Response(cached.body, { status: 200, headers: h });
    }
  }

  const dayKey = `gemini_tts:d:${utcDayKey()}`;
  const dailyCap = Number(env.GEMINI_TTS_DAILY_CAP) || SAFE_GEMINI_TTS_DAILY_REQ;
  const usedDay = await getCounter(env, dayKey);
  if (usedDay >= dailyCap) {
    return jsonResp({ error: 'Daily free-tier Gemini TTS cap reached.' }, 429, cors);
  }

  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-lite-tts:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `اقرأ النص العربي التالي بوضوح وتشكيل سليم ونبرة قراءة كتب هادئة دون إضافة أي تعليق:\n${text}` }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } }
        }
      })
    }
  );
  if (!upstream.ok) {
    return jsonResp({ error: 'Upstream Gemini TTS error', status: upstream.status }, upstream.status, cors);
  }

  const data = await upstream.json();
  const inline = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!inline?.data) return jsonResp({ error: 'No audio returned from Gemini TTS.' }, 502, cors);

  await addCounter(env, dayKey, 1, 2 * 86400);

  const bin = atob(inline.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  const audioResp = new Response(bytes, {
    status: 200,
    headers: {
      'content-type': inline.mimeType || 'audio/wav',
      'cache-control': 'public, max-age=2592000',
      'x-cache': 'MISS',
      ...cors
    }
  });
  if (edgeCache) await edgeCache.put(cacheUrl, audioResp.clone());
  return audioResp;
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/tts') return handleTts(request, env, cors);
    if (request.method === 'POST' && url.pathname === '/tts-gemini') return handleGeminiTts(request, env, cors);
    if (request.method === 'POST' && url.pathname === '/discuss') return handleDiscuss(request, env, cors);
    if (request.method === 'GET' && url.pathname === '/status') {
      const [usedMonth, usedDay, usedGemini, usedGeminiTts] = await Promise.all([
        getCounter(env, `tts:m:${utcMonthKey()}`),
        getCounter(env, `tts:d:${utcDayKey()}`),
        getCounter(env, `gemini:d:${utcDayKey()}`),
        getCounter(env, `gemini_tts:d:${utcDayKey()}`)
      ]);
      return jsonResp({
        status: 'ok',
        kvPersistent: Boolean(env.QUOTA_KV),
        secretsConfigured: {
          googleTts: Boolean(env.GOOGLE_TTS_API_KEY),
          gemini: Boolean(env.GEMINI_API_KEY)
        },
        usage: {
          chirpMonthlyChars: usedMonth,
          chirpMonthlyCap: Math.min(SAFE_MONTHLY_CHARS, Number(env.CHIRP_MONTHLY_CAP) || SAFE_MONTHLY_CHARS),
          chirpDailyChars: usedDay,
          chirpDailyCap: Number(env.CHIRP_DAILY_CAP) || SAFE_DAILY_CHARS,
          geminiDailyRequests: usedGemini,
          geminiDailyCap: Number(env.GEMINI_DAILY_CAP) || SAFE_GEMINI_DAILY_REQ,
          geminiTtsDailyRequests: usedGeminiTts,
          geminiTtsDailyCap: Number(env.GEMINI_TTS_DAILY_CAP) || SAFE_GEMINI_TTS_DAILY_REQ
        }
      }, 200, cors);
    }
    return jsonResp({ status: 'ok', endpoints: ['GET /status', 'POST /tts', 'POST /tts-gemini', 'POST /discuss'] }, 200, cors);
  }
};
