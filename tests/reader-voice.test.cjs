const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../reader-voice-core.js');

test('cleanTextForTTS strips tatweel, footnotes, decorative lines, and extra spaces', () => {
  const raw = 'الفـصـل الأول   [1]  ***  هذا   نص   تجريبي  (2)   .';
  const res = Core.cleanTextForTTS(raw);
  assert.equal(res.text, 'الفصل الأول هذا نص تجريبي.');
  assert.ok(res.savedChars > 10);
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
