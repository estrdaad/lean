const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../reader-voice-core.js');

test('cleanTextForTTS strips tatweel, footnotes, decorative lines, and extra spaces', () => {
  const raw = 'الفـصـل الأول   [1]  ***  هذا   نص   تجريبي  (2)   .';
  const res = Core.cleanTextForTTS(raw);
  assert.equal(res.text, 'الفصل الأول هذا نص تجريبي.');
  assert.ok(res.savedChars > 10);
});

test('cleanReplyForSpeech strips markdown headings, bullets, and list markers', () => {
  const raw = '### الفكرة الرئيسية\n- **أولاً**: اختبار الفرضيات.\n1. ثانياً: التعلم السريع.';
  const clean = Core.cleanReplyForSpeech(raw);
  assert.equal(clean, 'الفكرة الرئيسية أولاً: اختبار الفرضيات. ثانياً: التعلم السريع.');
});

test('chunkParagraphs merges short paragraphs and splits overly long ones safely', () => {
  const longSentence = 'هذه جملة عربية واضحة للاختبار. '.repeat(35);
  const { chunks, totalSavedByClean } = Core.chunkParagraphs([
    { blockIndex: 0, text: 'عنوان قصير' },
    { blockIndex: 1, text: 'فقرة أولى قصيرة.' },
    { blockIndex: 2, text: longSentence }
  ]);
  assert.ok(chunks.length >= 2);
  assert.deepEqual(chunks[0].blockIndexes, [0, 1]);
  for (const c of chunks) {
    assert.ok(c.text.length <= Core.LIMITS.CHUNK_MAX_CHARS, `Chunk exceeded max: ${c.text.length}`);
  }
  assert.ok(totalSavedByClean >= 0);
});

test('makeAudioCacheKey is deterministic and distinguishes voice, rate, and text', () => {
  const k1 = Core.makeAudioCacheKey('chirp3', 'ar-XA-Chirp3-HD-Charon', 1.0, 'مرحبا');
  const k2 = Core.makeAudioCacheKey('chirp3', 'ar-XA-Chirp3-HD-Charon', 1, 'مرحبا');
  const k3 = Core.makeAudioCacheKey('chirp3', 'ar-XA-Chirp3-HD-Aoede', 1.0, 'مرحبا');
  const k4 = Core.makeAudioCacheKey('chirp3', 'ar-XA-Chirp3-HD-Charon', 1.25, 'مرحبا');
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
  assert.notEqual(k1, k4);
});

test('QuotaTracker strictly enforces $0/month Chirp 3 HD monthly & daily caps and rolls over', () => {
  const day1 = Date.UTC(2026, 10, 10, 12, 0, 0);
  const day2 = Date.UTC(2026, 10, 11, 12, 0, 0);
  const nextMonth = Date.UTC(2026, 11, 1, 0, 1, 0);

  const tracker = Core.createQuotaTracker({}, {
    chirpMonthlyCap: 50000,
    chirpDailyCap: 10000
  });

  assert.equal(tracker.canSpendChirp(9000, day1).allowed, true);
  tracker.recordChirpSpend(9000, day1);

  // Exceeds daily cap
  const dailyBlocked = tracker.canSpendChirp(2000, day1);
  assert.equal(dailyBlocked.allowed, false);
  assert.equal(dailyBlocked.reason, 'daily_cap');

  // Next day resets daily cap while preserving monthly usage
  assert.equal(tracker.canSpendChirp(9000, day2).allowed, true);
  tracker.recordChirpSpend(41000, day2); // total 50,000 == monthlyCap

  // Exceeds monthly cap
  const monthlyBlocked = tracker.canSpendChirp(1, day2, false);
  assert.equal(monthlyBlocked.allowed, false);
  assert.equal(monthlyBlocked.reason, 'monthly_cap');

  // Cache hits never increase spend
  const snap = tracker.recordChirpCacheHit(500, day2);
  assert.equal(snap.chirpSavedCacheChars, 500);
  assert.equal(snap.estimatedMonthlyCostUsd, 0);

  // Next UTC month resets monthly cap
  assert.equal(tracker.canSpendChirp(1000, nextMonth).allowed, true);
});

test('QuotaTracker enforces Gemini Free Tier daily cap and RPM cooldown', () => {
  const t0 = Date.UTC(2026, 10, 10, 10, 0, 0);
  const tracker = Core.createQuotaTracker({}, {
    geminiDailyCap: 2,
    geminiMinIntervalMs: 5000
  });

  assert.equal(tracker.canSpendGemini(t0).allowed, true);
  tracker.recordGeminiSpend(t0);

  // Cooldown active 2s later
  const cool = tracker.canSpendGemini(t0 + 2000);
  assert.equal(cool.allowed, false);
  assert.equal(cool.reason, 'cooldown');
  assert.equal(cool.waitMs, 3000);

  // Allowed after cooldown
  assert.equal(tracker.canSpendGemini(t0 + 6000).allowed, true);
  tracker.recordGeminiSpend(t0 + 6000);

  // Blocked after reaching daily cap
  const blocked = tracker.canSpendGemini(t0 + 20000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'daily_cap');

  // Allowed when daily cap is explicitly bypassed (after cooldown)
  const bypassed = tracker.canSpendGemini(t0 + 20000, false);
  assert.equal(bypassed.allowed, true);
});

test('buildGeminiPayload caps excerpt length, history turns, and output tokens', () => {
  const hugeExcerpt = 'أ'.repeat(5000);
  const longHistory = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'model',
    text: `رسالة رقم ${i}`
  }));

  const payload = Core.buildGeminiPayload({
    bookTitle: 'الشركة الناشئة المرنة',
    bookAuthor: 'إريك ريس',
    chapterTitle: 'الفصل الأول',
    excerpt: hugeExcerpt,
    question: 'ما الفكرة الأساسية؟',
    history: longHistory,
    concise: true
  });

  assert.equal(payload.generationConfig.maxOutputTokens, Core.LIMITS.GEMINI_MAX_OUTPUT_TOKENS);
  assert.equal(payload.contents.length, Core.LIMITS.GEMINI_MAX_HISTORY_TURNS + 1);
  const lastText = payload.contents[payload.contents.length - 1].parts[0].text;
  assert.ok(lastText.length < 1000);

  const expanded = Core.buildGeminiPayload({
    bookTitle: 'الشركة الناشئة المرنة',
    question: 'اشرح بالتفصيل',
    concise: false
  });
  assert.equal(expanded.generationConfig.maxOutputTokens, Core.LIMITS.GEMINI_EXPANDED_OUTPUT_TOKENS);
});

test('voice-bridge worker rejects over-limit text and enforces missing secret safety', async () => {
  const worker = (await import('../voice-bridge/worker.mjs')).default;
  const reqNoKey = new Request('https://worker.test/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://estrdaad.github.io' },
    body: JSON.stringify({ text: 'مرحبا' })
  });
  const resNoKey = await worker.fetch(reqNoKey, {});
  assert.equal(resNoKey.status, 503);

  const reqTooLong = new Request('https://worker.test/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://estrdaad.github.io' },
    body: JSON.stringify({ text: 'ب'.repeat(900) })
  });
  const resTooLong = await worker.fetch(reqTooLong, { GOOGLE_TTS_API_KEY: 'dummy' });
  assert.equal(resTooLong.status, 400);
});

test('voice-bridge worker falls back across Gemini TTS models on 429 and returns x-tts-engine header', async () => {
  const worker = (await import('../voice-bridge/worker.mjs')).default;
  const origFetch = global.fetch;
  const calledUrls = [];
  global.fetch = async (url) => {
    calledUrls.push(String(url));
    if (calledUrls.length === 1) {
      return new Response(JSON.stringify({ error: { message: 'Quota exceeded for model' } }), { status: 429 });
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ inlineData: { data: 'UklGRg==', mimeType: 'audio/wav' } }] } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const req = new Request('https://worker.test/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://estrdaad.github.io' },
      body: JSON.stringify({ text: 'اختبار الصوت' })
    });
    const res = await worker.fetch(req, { GEMINI_API_KEY: 'test-key' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-tts-engine'), 'gemini-tts');
    assert.equal(calledUrls.length, 2);
    assert.ok(calledUrls[0].includes('gemini-3.8-flash-lite-tts'));
    assert.ok(calledUrls[1].includes('gemini-3.8-flash-tts'));
  } finally {
    global.fetch = origFetch;
  }
});

test('voice-bridge worker stores and serves TTS audio from Cloudflare KV across devices with 0 extra quota', async () => {
  const worker = (await import('../voice-bridge/worker.mjs')).default;
  const origFetch = global.fetch;
  const kvStore = new Map();
  const mockKv = {
    async get(key, opts) {
      const entry = kvStore.get(key);
      if (!entry) return null;
      return opts?.type === 'arrayBuffer' ? entry.value : String(entry.value);
    },
    async getWithMetadata(key) {
      const entry = kvStore.get(key);
      if (!entry) return { value: null, metadata: null };
      return { value: entry.value, metadata: entry.metadata || null };
    },
    async put(key, value, opts) {
      kvStore.set(key, { value, metadata: opts?.metadata || null, ttl: opts?.expirationTtl });
    }
  };

  let upstreamCalls = 0;
  global.fetch = async () => {
    upstreamCalls++;
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ inlineData: { data: 'UklGRg==', mimeType: 'audio/wav' } }] } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const env = { GEMINI_API_KEY: 'test-key', QUOTA_KV: mockKv };
    const makeReq = () => new Request('https://worker.test/tts-gemini', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://estrdaad.github.io' },
      body: JSON.stringify({ text: 'فقرة محفوظة في السحابة', voice: 'Charon' })
    });

    // First device: MISS -> calls upstream & persists to KV
    const res1 = await worker.fetch(makeReq(), env);
    assert.equal(res1.status, 200);
    assert.equal(res1.headers.get('x-cache'), 'MISS');
    assert.equal(upstreamCalls, 1);

    // Second device: HIT-KV -> served directly from KV without calling upstream or spending quota
    const res2 = await worker.fetch(makeReq(), env);
    assert.equal(res2.status, 200);
    assert.equal(res2.headers.get('x-cache'), 'HIT-KV');
    assert.equal(res2.headers.get('x-tts-engine'), 'gemini-tts');
    assert.equal(res2.headers.get('content-type'), 'audio/wav');
    assert.ok((res2.headers.get('access-control-expose-headers') || '').includes('x-cache'));
    assert.equal(upstreamCalls, 1);

    // /status reports persistent audio cache
    const statusRes = await worker.fetch(new Request('https://worker.test/status'), env);
    const statusJson = await statusRes.json();
    assert.equal(statusJson.audioCachePersistent, true);
    assert.equal(statusJson.usage.geminiTtsDailyRequests, 1);
  } finally {
    global.fetch = origFetch;
  }
});

test('createPrefetchGate unlocks only after 3 consecutive clips within 10 minutes and resets on navigation', () => {
  const gate = Core.createPrefetchGate({ requiredConsecutive: 3, windowMs: 10 * 60 * 1000 });
  const t0 = Date.UTC(2026, 10, 26, 10, 0, 0);

  assert.equal(gate.isUnlocked(t0), false);
  assert.equal(gate.recordCompletedClip(t0), false);
  assert.equal(gate.recordCompletedClip(t0 + 60_000), false);
  assert.equal(gate.isUnlocked(t0 + 60_000), false);

  // 3rd consecutive clip within 10 minutes unlocks prefetch
  assert.equal(gate.recordCompletedClip(t0 + 120_000), true);
  assert.equal(gate.isUnlocked(t0 + 180_000), true);

  // Expires after 10 minutes from the earliest of the 3 clips
  assert.equal(gate.isUnlocked(t0 + 10 * 60 * 1000 + 1), false);

  // Manual navigation resets streak completely
  gate.recordCompletedClip(t0 + 20 * 60 * 1000);
  gate.recordCompletedClip(t0 + 21 * 60 * 1000);
  gate.recordCompletedClip(t0 + 22 * 60 * 1000);
  assert.equal(gate.isUnlocked(t0 + 22 * 60 * 1000), true);
  gate.reset();
  assert.equal(gate.isUnlocked(t0 + 22 * 60 * 1000), false);
  assert.equal(gate.count(t0 + 22 * 60 * 1000), 0);
});
