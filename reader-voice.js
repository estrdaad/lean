/* Dual-Mode Voice Reader (Google Cloud Chirp 3 HD) & Book Discussion (Gemini Free Tier)
 * Zero-cost-guaranteed architecture with IndexedDB audio caching, smart chunking,
 * automatic Web Speech API fallback, and seamless Reading <-> Discussion switching.
 */
(async function () {
  'use strict';

  const Core = window.ReaderVoiceCore;
  if (!Core) return;

  await window.BookLibrary.ready;
  await window.LibbyApp.ready;

  const app = window.LibbyApp;
  const article = document.getElementById('book-article');
  const columnWindow = document.getElementById('reader-column-window');

  const STORAGE_SETTINGS = 'goog-reader-voice-settings-v2';
  const STORAGE_SETTINGS_V1 = 'goog-reader-voice-settings-v1';
  const STORAGE_QUOTA = 'goog-reader-voice-quota-v1';
  const DB_NAME = 'goog-reader-tts-cache-v1';
  const DB_STORE = 'audio_clips';
  const MAX_CACHE_ENTRIES = 400;

  // --- Persistent Settings (kept strictly in local browser storage) ---
  function loadSettings() {
    const defaults = {
      proxyUrl: 'https://goog-voice-bridge.estrdaad-reader.workers.dev', // Live Cloudflare Worker proxy
      googleTtsApiKey: '',                // Optional direct Google Cloud TTS API key (restricted)
      geminiApiKey: '',                   // Optional direct Google AI Studio Free Tier key
      ttsEngine: 'auto',                  // 'auto' (Chirp 3 -> Gemini TTS -> Browser) | 'chirp3' | 'gemini-tts'
      chirpVoice: Core.CHIRP3_VOICES[0].id,
      geminiModel: Core.GEMINI_MODELS[0].id,
      speakingRate: 1.0,
      chirpMonthlyCap: Core.LIMITS.CHIRP3_SAFE_MONTHLY_CAP,
      chirpDailyCap: Core.LIMITS.CHIRP3_SAFE_DAILY_CAP,
      geminiDailyCap: Core.LIMITS.GEMINI_SAFE_DAILY_REQUESTS,
      bypassDailyCap: false,              // Allows exceeding daily cap while preserving monthly $0 cap
      autoTurnPage: true,
      conciseDiscussion: false,           // Expanded in-depth discussion replies by default
      speakDiscussionReplies: true        // Automatically synthesize & speak discussion replies
    };
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_SETTINGS) || 'null');
      if (saved) return { ...defaults, ...saved };
      // Migrate credentials/voice from v1 while adopting new v2 discussion & auto-speak defaults
      const v1 = JSON.parse(localStorage.getItem(STORAGE_SETTINGS_V1) || 'null');
      if (v1) {
        return {
          ...defaults,
          proxyUrl: v1.proxyUrl || defaults.proxyUrl,
          googleTtsApiKey: v1.googleTtsApiKey || '',
          geminiApiKey: v1.geminiApiKey || '',
          chirpVoice: v1.chirpVoice || defaults.chirpVoice,
          speakingRate: v1.speakingRate || defaults.speakingRate
        };
      }
      return defaults;
    } catch {
      return defaults;
    }
  }

  function saveSettings(next) {
    settings = { ...settings, ...next };
    try {
      localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(settings));
    } catch (e) {
      console.warn('Could not save voice settings', e);
    }
    rebuildTracker();
    renderQuotaUI();
  }

  let settings = loadSettings();
  let tracker = null;

  function loadQuotaState() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_QUOTA) || '{}');
    } catch {
      return {};
    }
  }

  function persistQuota(snapshot) {
    try {
      localStorage.setItem(STORAGE_QUOTA, JSON.stringify(snapshot));
    } catch {}
  }

  function rebuildTracker() {
    tracker = Core.createQuotaTracker(loadQuotaState(), {
      chirpMonthlyCap: settings.chirpMonthlyCap,
      chirpDailyCap: settings.chirpDailyCap,
      geminiDailyCap: settings.geminiDailyCap
    });
  }
  rebuildTracker();

  // --- IndexedDB Audio Cache (saves 100% quota on repeated passages) ---
  let dbPromise = null;
  function openCacheDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      if (!('indexedDB' in window)) return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          const store = db.createObjectStore(DB_STORE, { keyPath: 'key' });
          store.createIndex('touchedAt', 'touchedAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    return dbPromise;
  }

  async function cacheGetAudio(key) {
    const db = await openCacheDB();
    if (!db) return null;
    return new Promise((resolve) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);
      const req = store.get(key);
      req.onsuccess = () => {
        const rec = req.result;
        if (rec) {
          rec.touchedAt = Date.now();
          store.put(rec);
          resolve(rec.blob);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  }

  async function cachePutAudio(key, blob) {
    const db = await openCacheDB();
    if (!db) return;
    return new Promise((resolve) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);
      store.put({ key, blob, touchedAt: Date.now() });
      const countReq = store.count();
      countReq.onsuccess = () => {
        if (countReq.result > MAX_CACHE_ENTRIES) {
          const idx = store.index('touchedAt');
          const cur = idx.openCursor();
          let toDelete = countReq.result - MAX_CACHE_ENTRIES;
          cur.onsuccess = () => {
            const c = cur.result;
            if (c && toDelete > 0) {
              c.delete();
              toDelete--;
              c.continue();
            }
          };
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  async function cacheClearAll() {
    const db = await openCacheDB();
    if (!db) return;
    return new Promise((resolve) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  // --- Extract Clean Visible Page Text (skips footnotes & page anchors) ---
  function extractCleanBlockText(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.footnote-link, .source-page-anchor, sup, script, style').forEach(n => n.remove());
    return clone.textContent || '';
  }

  function getVisiblePageParagraphs() {
    const blocks = [...article.querySelectorAll('p,h1,h2,h3,h4,li')];
    if (!blocks.length) return [];
    const viewport = columnWindow ? columnWindow.getBoundingClientRect() : null;
    const visible = [];
    blocks.forEach((el, idx) => {
      const text = extractCleanBlockText(el).trim();
      if (!text) return;
      if (viewport && viewport.width > 0) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const rects = [...range.getClientRects()];
        const inView = rects.some(r => {
          const overlapX = Math.min(r.right, viewport.right - 6) - Math.max(r.left, viewport.left + 6);
          const overlapY = Math.min(r.bottom, viewport.bottom - 4) - Math.max(r.top, viewport.top + 4);
          return overlapX > 12 && overlapY > 4;
        });
        if (!inView) return;
      }
      visible.push({ blockIndex: idx, text });
    });

    if (visible.length) return visible;
    // Fallback to readingLocation block if viewport rects are unavailable
    const loc = app.state.readingLocation;
    const startIdx = loc && Number.isInteger(loc.block) ? loc.block : 0;
    return blocks.slice(startIdx, startIdx + 4).map((el, i) => ({
      blockIndex: startIdx + i,
      text: extractCleanBlockText(el).trim()
    })).filter(x => x.text);
  }

  function getCurrentExcerptForDiscussion() {
    const selection = window.getSelection();
    if (selection && article.contains(selection.anchorNode) && article.contains(selection.focusNode)) {
      const selected = selection.toString().trim();
      if (selected.length >= 12) return selected.slice(0, Core.LIMITS.GEMINI_MAX_CONTEXT_CHARS);
    }
    const allBlocks = [...article.querySelectorAll('p,h1,h2,h3,h4,li')];
    const paragraphs = getVisiblePageParagraphs();
    if (!paragraphs.length) return '';
    // Include up to 2 preceding paragraphs for stronger narrative continuity
    const firstIdx = paragraphs[0].blockIndex;
    const leadIn = [];
    for (let i = Math.max(0, firstIdx - 2); i < firstIdx; i++) {
      const t = extractCleanBlockText(allBlocks[i]).trim();
      if (t) leadIn.push(t);
    }
    const combined = [...leadIn, ...paragraphs.map(p => p.text)].join('\n');
    return combined.slice(0, Core.LIMITS.GEMINI_MAX_CONTEXT_CHARS);
  }

  // --- Live Cloudflare KV Status Sync ---
  let remoteStatus = null;
  async function refreshRemoteStatus() {
    const proxyBase = (settings.proxyUrl || '').trim().replace(/\/+$/, '');
    if (!proxyBase) return;
    try {
      const res = await fetch(`${proxyBase}/status`, { cache: 'no-store' });
      if (!res.ok) return;
      remoteStatus = await res.json();
      renderQuotaUI();
    } catch {}
  }

  // --- Audio Synthesis Backends (Chirp 3 HD + Free Browser Fallback) ---
  let sharedAudio = new Audio();
  sharedAudio.preload = 'auto';
  sharedAudio.setAttribute('playsinline', '');
  let audioCtx = null;
  let activeWebAudioSource = null;
  let activeAudio = null;
  let activeAudioUrl = null;
  let activeAbort = null;
  let prefetchAbort = null;
  let prefetchMap = new Map(); // prefetchKey -> Promise<{ blob, source, engine } | null>

  function makePrefetchKey(text) {
    return Core.makeAudioCacheKey(settings.ttsEngine || 'auto', settings.chirpVoice, settings.speakingRate, text);
  }

  async function normalizeAudioBlob(blob) {
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const isRiff = bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
    const isMp3 = bytes.length >= 3 && ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));
    const type = isRiff ? 'audio/wav' : (isMp3 ? 'audio/mpeg' : (blob.type || 'audio/wav'));
    return { blob: new Blob([bytes], { type }), buffer: buf };
  }

  function playBufferWithWebAudio(arrayBuffer) {
    return new Promise((resolve, reject) => {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return reject(new Error('المتصفح لا يدعم تشغيل هذا الملف الصوتي.'));
      if (!audioCtx) audioCtx = new Ctx();
      audioCtx.resume().catch(() => {});
      audioCtx.decodeAudioData(arrayBuffer.slice(0), (decoded) => {
        const src = audioCtx.createBufferSource();
        src.buffer = decoded;
        src.connect(audioCtx.destination);
        activeWebAudioSource = src;
        src.onended = () => {
          if (activeWebAudioSource === src) activeWebAudioSource = null;
          resolve();
        };
        src.start(0);
      }, () => reject(new Error('تعذّر فك ترميز المقطع الصوتي.')));
    });
  }

  async function playBlobReliably(rawBlob) {
    const { blob, buffer } = await normalizeAudioBlob(rawBlob);
    if (activeAudioUrl) URL.revokeObjectURL(activeAudioUrl);
    activeAudioUrl = URL.createObjectURL(blob);
    activeAudio = sharedAudio;
    activeAudio.muted = false;
    activeAudio.src = activeAudioUrl;
    activeAudio.load();
    try {
      await new Promise((resolve, reject) => {
        activeAudio.onended = resolve;
        activeAudio.onerror = () => reject(new Error('AUDIO_ELEMENT_ERROR'));
        const p = activeAudio.play();
        if (p && typeof p.catch === 'function') p.catch(reject);
      });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      // Only fall back to Web Audio API if HTMLAudioElement itself failed to decode
      activeAudio.onended = null;
      activeAudio.onerror = null;
      activeAudio.pause();
      await playBufferWithWebAudio(buffer);
    }
  }

  function updateMediaSession(isPlayingNow) {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    try {
      const book = window.BookLibrary.activeBook || {};
      navigator.mediaSession.metadata = new MediaMetadata({
        title: app.state.currentChapterTitle || book.title || 'مكتبة القراءة',
        artist: book.author || 'القارئ الصوتي',
        album: book.title || ''
      });
      navigator.mediaSession.playbackState = isPlayingNow ? 'playing' : 'paused';
    } catch {}
  }

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', () => { if (!playback.isPlaying) togglePlayPause(); });
      navigator.mediaSession.setActionHandler('pause', () => { if (playback.isPlaying) pauseReading(); });
      navigator.mediaSession.setActionHandler('stop', () => stopReading(false));
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        if (!playback.chunks.length) return;
        playback.chunkIndex = Math.min(playback.chunks.length - 1, playback.chunkIndex + 1);
        stopAudioHardware();
        playback.isPlaying = true;
        playback.isPaused = false;
        playCurrentChunk();
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        if (!playback.chunks.length) return;
        playback.chunkIndex = Math.max(0, playback.chunkIndex - 1);
        stopAudioHardware();
        playback.isPlaying = true;
        playback.isPaused = false;
        playCurrentChunk();
      });
    } catch {}
  }

  function base64ToAudioBlob(base64, mime = 'audio/mpeg') {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function formatTtsError(defaultEngineLabel, status, errText, headerEngine) {
    let parsed = null;
    try { parsed = JSON.parse(errText); } catch {}
    const isGemini = headerEngine === 'gemini-tts'
      || parsed?.engine === 'gemini-tts'
      || /Gemini TTS/i.test(parsed?.error || errText || '');
    const engineLabel = isGemini ? 'Gemini TTS' : defaultEngineLabel;

    let msg;
    if (status === 429 && isGemini) {
      msg = 'تم بلوغ حد الباقة المجانية المؤقت لـ Gemini TTS (429). انتظر دقيقة ثم أعد المحاولة، أو أضف مفتاح Google Cloud TTS (Chirp 3 HD — 900,000 حرف مجاني شهريًا) من الإعدادات.';
    } else if (status === 429) {
      msg = `تم بلوغ الحد المجاني الآمن لـ ${engineLabel} (429).`;
    } else {
      const detail = parsed?.detail || parsed?.error || errText.slice(0, 140);
      msg = `خطأ ${engineLabel} (${status}): ${detail}`;
    }
    const err = new Error(msg);
    err.code = status === 429 ? 'QUOTA_GUARD' : 'API_ERROR';
    err.alreadyTriedGemini = isGemini;
    return err;
  }

  async function synthesizeChirp3(text, signal) {
    const voice = settings.chirpVoice || Core.CHIRP3_VOICES[0].id;
    const rate = Number(settings.speakingRate) || 1.0;
    const cacheKey = Core.makeAudioCacheKey('chirp3-v3', voice, rate, text);

    const cached = await cacheGetAudio(cacheKey);
    if (cached) {
      persistQuota(tracker.recordChirpCacheHit(text.length));
      renderQuotaUI();
      return { blob: cached, source: 'cache', engine: 'chirp3' };
    }

    const check = tracker.canSpendChirp(text.length, Date.now(), !settings.bypassDailyCap);
    if (!check.allowed) {
      const err = new Error(
        check.reason === 'monthly_cap'
          ? 'تم بلوغ الحد الشهري الآمن (0$ مضمون) لـ Chirp 3 HD.'
          : 'تم بلوغ الحد اليومي الآمن لتوزيع الرصيد المجاني على الشهر.'
      );
      err.code = 'QUOTA_GUARD';
      throw err;
    }

    const proxyBase = (settings.proxyUrl || '').trim().replace(/\/+$/, '');
    const apiKey = (settings.googleTtsApiKey || '').trim();
    if (!proxyBase && !apiKey) {
      const err = new Error('لم يتم إدخال مفتاح Google Cloud TTS أو رابط الوسيط بعد.');
      err.code = 'NO_CREDENTIALS';
      throw err;
    }

    let response;
    if (proxyBase) {
      response = await fetch(`${proxyBase}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, voice, speakingRate: rate, bypassDailyCap: Boolean(settings.bypassDailyCap) }),
        signal
      });
    } else {
      response = await fetch(
        `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            input: { text },
            voice: { languageCode: 'ar-XA', name: voice },
            audioConfig: { audioEncoding: 'MP3', speakingRate: rate }
          }),
          signal
        }
      );
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw formatTtsError('Chirp 3 HD', response.status, errText, response.headers.get('x-tts-engine'));
    }

    const contentType = response.headers.get('content-type') || '';
    let blob;
    if (contentType.includes('audio/')) {
      blob = await response.blob();
    } else {
      const data = await response.json();
      if (!data.audioContent) throw new Error('لم يرجع صوت من Google TTS.');
      blob = base64ToAudioBlob(data.audioContent, 'audio/mpeg');
    }

    const servedEngine = response.headers.get('x-tts-engine') === 'gemini-tts' ? 'gemini-tts' : 'chirp3';
    if (servedEngine === 'chirp3') {
      persistQuota(tracker.recordChirpSpend(text.length));
      renderQuotaUI();
    }
    await cachePutAudio(cacheKey, blob);
    return { blob, source: 'network', engine: servedEngine };
  }

  async function synthesizeGeminiTts(text, signal) {
    const voice = (settings.chirpVoice || Core.CHIRP3_VOICES[0].id).replace(/^ar-XA-Chirp3-HD-/, '');
    const cacheKey = Core.makeAudioCacheKey('gemini-tts-v3', voice, 1.0, text);

    const cached = await cacheGetAudio(cacheKey);
    if (cached) {
      persistQuota(tracker.recordChirpCacheHit(text.length));
      renderQuotaUI();
      return { blob: cached, source: 'cache', engine: 'gemini-tts' };
    }

    const proxyBase = (settings.proxyUrl || '').trim().replace(/\/+$/, '');
    const apiKey = (settings.geminiApiKey || '').trim();
    if (!proxyBase && !apiKey) {
      const err = new Error('لم يتم إعداد مفتاح Gemini أو الوسيط السحابي.');
      err.code = 'NO_CREDENTIALS';
      throw err;
    }

    let response;
    if (proxyBase) {
      response = await fetch(`${proxyBase}/tts-gemini`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, voice, bypassDailyCap: Boolean(settings.bypassDailyCap) }),
        signal
      });
    } else {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-lite-tts:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text }] }],
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
            }
          }),
          signal
        }
      );
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw formatTtsError('Gemini TTS', response.status, errText, 'gemini-tts');
    }

    const contentType = response.headers.get('content-type') || '';
    let blob;
    if (contentType.includes('audio/')) {
      blob = await response.blob();
    } else {
      const data = await response.json();
      const inline = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
      if (!inline?.data) throw new Error('لم يرجع صوت من Gemini TTS.');
      blob = base64ToAudioBlob(inline.data, inline.mimeType || 'audio/wav');
    }

    await cachePutAudio(cacheKey, blob);
    return { blob, source: 'network', engine: 'gemini-tts' };
  }

  async function synthesizeSelectedEngine(text, signal) {
    const mode = settings.ttsEngine || 'auto';
    if (mode === 'gemini-tts') return synthesizeGeminiTts(text, signal);
    if (mode === 'chirp3') return synthesizeChirp3(text, signal);
    try {
      return await synthesizeChirp3(text, signal);
    } catch (err) {
      if (err.name === 'AbortError' || err.alreadyTriedGemini) throw err;
      return synthesizeGeminiTts(text, signal);
    }
  }

  // --- Playback State Machine (Reading Mode — Logical Continuous Queue) ---
  const playback = {
    isPlaying: false,
    isPaused: false,
    chunks: [],
    chunkIndex: 0,
    pageNumber: 1,
    lastBlockIndex: -1,
    activeEngine: 'chirp3'
  };

  function stopAudioHardware() {
    if (activeAbort) { activeAbort.abort(); activeAbort = null; }
    if (prefetchAbort) { prefetchAbort.abort(); prefetchAbort = null; }
    if (activeWebAudioSource) {
      try { activeWebAudioSource.onended = null; activeWebAudioSource.stop(); } catch {}
      activeWebAudioSource = null;
    }
    if (activeAudio) {
      activeAudio.onended = null;
      activeAudio.onerror = null;
      activeAudio.pause();
      activeAudio = null;
    }
    if (activeAudioUrl) {
      URL.revokeObjectURL(activeAudioUrl);
      activeAudioUrl = null;
    }
    prefetchMap.clear();
  }

  function stopReading(resetPosition = false) {
    playback.isPlaying = false;
    playback.isPaused = false;
    if (resetPosition) {
      playback.chunks = [];
      playback.chunkIndex = 0;
    }
    stopAudioHardware();
    updateReadUI();
  }

  function pauseReading() {
    if (!playback.isPlaying) return;
    playback.isPlaying = false;
    playback.isPaused = true;
    if (activeAudio && !activeAudio.paused) {
      activeAudio.pause();
    }
    updateReadUI();
  }

  function resumeReading() {
    if (!playback.isPaused) return;
    playback.isPlaying = true;
    playback.isPaused = false;
    if (activeAudio && activeAudio.paused && activeAudio.src) {
      activeAudio.play().catch(() => playCurrentChunk());
      updateReadUI();
      return;
    }
    playCurrentChunk();
  }

  function prefetchNextChunk() {
    if (!playback.isPlaying) return;
    // Avoid tripping Gemini TTS free-tier RPM/RPD limits with speculative prefetching
    if (playback.activeEngine === 'gemini-tts' || settings.ttsEngine === 'gemini-tts') return;
    const nextIdx = playback.chunkIndex + 1;
    if (nextIdx >= playback.chunks.length) return;
    const nextText = playback.chunks[nextIdx].text;
    const key = makePrefetchKey(nextText);
    if (prefetchMap.has(key)) return;
    if (!settings.proxyUrl && !settings.googleTtsApiKey && !settings.geminiApiKey) return;
    if (prefetchAbort) prefetchAbort.abort();
    prefetchAbort = new AbortController();
    const p = synthesizeSelectedEngine(nextText, prefetchAbort.signal).catch(() => null);
    prefetchMap.set(key, p);
  }

  async function playCurrentChunk() {
    if (!playback.isPlaying) return;
    if (playback.chunkIndex >= playback.chunks.length) {
      // Seamlessly continue reading next logical blocks even while iPhone screen is locked
      if (settings.autoTurnPage && loadLogicalChunksFrom(playback.lastBlockIndex + 1)) {
        return playCurrentChunk();
      }
      stopReading(true);
      setReadStatus('انتهت قراءة الكتاب.');
      return;
    }

    const chunk = playback.chunks[playback.chunkIndex];
    syncVisualPageToChunk(chunk);
    updateReadUI();

    try {
      activeAbort = new AbortController();
      const key = makePrefetchKey(chunk.text);
      const pendingPrefetch = prefetchMap.get(key);
      if (!pendingPrefetch) setReadStatus('جارٍ تجهيز الصوت...');
      const result = (pendingPrefetch && (await pendingPrefetch)) || (await synthesizeSelectedEngine(chunk.text, activeAbort.signal));
      prefetchMap.delete(key);
      if (!playback.isPlaying) return;

      playback.activeEngine = result.engine;
      const engineName = result.engine === 'gemini-tts' ? 'Gemini 3.8 Flash-Lite TTS' : 'Chirp 3 HD';
      setReadStatus(result.source === 'cache'
        ? `يقرأ الآن: ${engineName} (من الذاكرة المؤقتة — 0 استهلاك)`
        : `يقرأ الآن: ${engineName} (0$ ضمن الباقة المجانية)`);

      // Immediately prefetch next chunk while current chunk is playing for seamless transitions
      prefetchNextChunk();
      refreshRemoteStatus();
      await playBlobReliably(result.blob);
      if (!playback.isPlaying) return;
      playback.chunkIndex += 1;
      playCurrentChunk();
    } catch (err) {
      if (err.name === 'AbortError' || !playback.isPlaying) return;
      stopReading(false);
      setReadStatus(err.message);
    }
  }

  function loadLogicalChunksFrom(startBlockIdx) {
    const allBlocks = [...article.querySelectorAll('p,h1,h2,h3,h4,li')];
    if (!allBlocks.length || startBlockIdx >= allBlocks.length) {
      playback.chunks = [];
      playback.chunkIndex = 0;
      return false;
    }
    const batch = [];
    let endIdx = startBlockIdx;
    for (let i = Math.max(0, startBlockIdx); i < allBlocks.length && batch.length < 24; i++) {
      endIdx = i;
      const text = extractCleanBlockText(allBlocks[i]).trim();
      if (text) batch.push({ blockIndex: i, text });
    }
    const useFullPageChunks = settings.ttsEngine === 'gemini-tts' || (settings.ttsEngine !== 'chirp3' && !settings.googleTtsApiKey);
    const chunkOpts = useFullPageChunks
      ? { targetChars: Core.LIMITS.GEMINI_TTS_TARGET_CHARS, maxChars: Core.LIMITS.GEMINI_TTS_MAX_CHARS }
      : { targetChars: Core.LIMITS.CHUNK_TARGET_CHARS, maxChars: Core.LIMITS.CHUNK_MAX_CHARS };
    const { chunks, totalSavedByClean } = Core.chunkParagraphs(batch, chunkOpts);
    if (totalSavedByClean > 0) {
      persistQuota(tracker.recordCleanSavings(totalSavedByClean));
      renderQuotaUI();
    }
    playback.chunks = chunks;
    playback.chunkIndex = 0;
    playback.lastBlockIndex = endIdx;
    playback.pageNumber = app.state.currentPage;
    return chunks.length > 0;
  }

  function loadCurrentPageChunks() {
    const visible = getVisiblePageParagraphs();
    const startIdx = visible.length
      ? visible[0].blockIndex
      : (Number.isInteger(app.state.readingLocation?.block) ? app.state.readingLocation.block : 0);
    return loadLogicalChunksFrom(startIdx);
  }

  function syncVisualPageToChunk(chunk) {
    if (!settings.autoTurnPage || document.hidden || !chunk?.blockIndexes?.length) return;
    const allBlocks = [...article.querySelectorAll('p,h1,h2,h3,h4,li')];
    const targetEl = allBlocks[chunk.blockIndexes[0]];
    if (!targetEl || !columnWindow) return;
    const viewport = columnWindow.getBoundingClientRect();
    const rect = targetEl.getBoundingClientRect();
    const alreadyVisible = rect.right > viewport.left + 8 && rect.left < viewport.right - 8;
    if (!alreadyVisible && typeof app.restoreProgress === 'function') {
      const fullBlocks = [...article.querySelectorAll('p,h1,h2,h3,h4,li,figure,table')];
      const fullIdx = fullBlocks.indexOf(targetEl);
      if (fullIdx >= 0) {
        app.restoreProgress({ page: app.state.currentPage, location: { block: fullIdx, offset: 0 }, pause: app.state.pauseMarker });
        playback.pageNumber = app.state.currentPage;
      }
    }
  }

  function togglePlayPause() {
    primeAudioForMobile();
    if (playback.isPlaying) {
      pauseReading();
      return;
    }
    if (playback.isPaused && playback.pageNumber === app.state.currentPage && playback.chunks.length) {
      resumeReading();
      return;
    }
    stopAudioHardware();
    loadCurrentPageChunks();
    if (!playback.chunks.length) {
      setReadStatus('لا يوجد نص مقروء في هذه الصفحة.');
      return;
    }
    playback.isPlaying = true;
    playback.isPaused = false;
    playCurrentChunk();
  }

  // --- Discussion Mode (Gemini Free Tier) ---
  const discussion = {
    history: [],
    cache: new Map(), // hash(bookId+excerpt+question) -> reply text
    busy: false
  };

  async function askGemini(questionText) {
    const q = String(questionText || '').trim();
    if (!q || discussion.busy) return;
    if (settings.speakDiscussionReplies) primeAudioForMobile();

    const book = window.BookLibrary.activeBook;
    const excerpt = getCurrentExcerptForDiscussion();
    const cacheKey = Core.hashKey(`${book.id}|${settings.geminiModel}|${settings.conciseDiscussion ? 'c' : 'e'}|${excerpt.slice(0, 300)}|${q}`);

    appendChatMessage('user', q);

    if (discussion.cache.has(cacheKey)) {
      persistQuota(tracker.recordGeminiCacheHit());
      renderQuotaUI();
      const cachedReply = discussion.cache.get(cacheKey);
      appendChatMessage('model', cachedReply, true);
      if (settings.speakDiscussionReplies) speakReplyText(cachedReply);
      return;
    }

    const check = tracker.canSpendGemini(Date.now(), !settings.bypassDailyCap);
    if (!check.allowed) {
      if (check.reason === 'cooldown') {
        const secs = Math.ceil(check.waitMs / 1000);
        appendChatMessage('model', `انتظر ${secs} ثوانٍ لحماية حد الطلبات المجاني في الدقيقة (RPM).`);
      } else {
        appendChatMessage('model', 'تم بلوغ الحد اليومي الآمن للباقة المجانية في Gemini (0$). سيتجدد تلقائيًا غدًا.');
      }
      return;
    }

    const proxyBase = (settings.proxyUrl || '').trim().replace(/\/+$/, '');
    const apiKey = (settings.geminiApiKey || '').trim();
    if (!proxyBase && !apiKey) {
      appendChatMessage('model', 'أضف مفتاح Gemini المجاني (من Google AI Studio دون بطاقة بنكية) أو رابط الوسيط من تبويب «الإعدادات» لبدء المناقشة.');
      return;
    }

    const payload = Core.buildGeminiPayload({
      bookTitle: book.title,
      bookAuthor: book.author,
      chapterTitle: app.state.currentChapterTitle,
      excerpt,
      question: q,
      history: discussion.history,
      concise: settings.conciseDiscussion
    });

    discussion.busy = true;
    updateDiscussUI();
    const pendingEl = appendChatMessage('model', 'يفكّر Gemini (الباقة المجانية)...');

    try {
      let response;
      if (proxyBase) {
        response = await fetch(`${proxyBase}/discuss`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: settings.geminiModel, payload, bypassDailyCap: Boolean(settings.bypassDailyCap) })
        });
      } else {
        const model = encodeURIComponent(settings.geminiModel || Core.GEMINI_MODELS[0].id);
        response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
          }
        );
      }

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(`خطأ Gemini (${response.status}): ${errBody.slice(0, 140)}`);
      }

      const data = await response.json();
      const reply = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('\n').trim();
      if (!reply) throw new Error('لم يرجع رد نصي من Gemini.');

      persistQuota(tracker.recordGeminiSpend(Date.now()));
      renderQuotaUI();

      discussion.history.push({ role: 'user', text: q });
      discussion.history.push({ role: 'model', text: reply });
      if (discussion.history.length > Core.LIMITS.GEMINI_MAX_HISTORY_TURNS * 2) {
        discussion.history = discussion.history.slice(-Core.LIMITS.GEMINI_MAX_HISTORY_TURNS * 2);
      }
      discussion.cache.set(cacheKey, reply);

      pendingEl.remove();
      appendChatMessage('model', reply, false);

      if (settings.speakDiscussionReplies) {
        speakReplyText(reply);
      }
    } catch (err) {
      pendingEl.textContent = err.message;
    } finally {
      discussion.busy = false;
      updateDiscussUI();
    }
  }

  // Unlock HTMLAudioElement with a valid tiny silent WAV on user gesture so iOS allows background playback
  let silentPrimeUrl = null;
  function getSilentWavUrl() {
    if (silentPrimeUrl) return silentPrimeUrl;
    const sampleCount = 1200; // 0.05s at 24kHz
    const dataLen = sampleCount * 2;
    const buf = new ArrayBuffer(44 + dataLen);
    const v = new DataView(buf);
    const w = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); w(8, 'WAVE');
    w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 24000, true); v.setUint32(28, 48000, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, dataLen, true);
    silentPrimeUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    return silentPrimeUrl;
  }

  function primeAudioForMobile() {
    try {
      if (sharedAudio.paused && !sharedAudio.currentTime) {
        sharedAudio.src = getSilentWavUrl();
        const p = sharedAudio.play();
        if (p && typeof p.then === 'function') p.catch(() => {});
      }
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        if (!audioCtx) audioCtx = new Ctx();
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      }
    } catch {}
  }

  let replyPlaybackActive = false;

  async function speakReplyText(text) {
    stopAudioHardware();
    playback.isPlaying = false;
    playback.isPaused = false;
    updateReadUI();

    const cleanFull = Core.cleanReplyForSpeech(text);
    if (!cleanFull) return;
    const { chunks } = Core.chunkParagraphs([{ blockIndex: 0, text: cleanFull }]);
    if (!chunks.length) return;

    replyPlaybackActive = true;
    updateDiscussAudioBtn();

    let nextPrefetch = null;
    try {
      for (let i = 0; i < chunks.length; i++) {
        if (!replyPlaybackActive) break;
        const piece = chunks[i].text;
        activeAbort = new AbortController();
        const res = (nextPrefetch && (await nextPrefetch)) || (await synthesizeSelectedEngine(piece, activeAbort.signal));
        nextPrefetch = null;
        if (!replyPlaybackActive) break;

        // Prefetch next chunk of the reply while playing current one (Chirp 3 HD only to protect Gemini TTS RPM)
        if (i + 1 < chunks.length && res.engine !== 'gemini-tts') {
          prefetchAbort = new AbortController();
          nextPrefetch = synthesizeSelectedEngine(chunks[i + 1].text, prefetchAbort.signal).catch(() => null);
        }

        await playBlobReliably(res.blob);
      }
    } catch (err) {
      if (err?.name !== 'AbortError') setReadStatus(err.message || 'تعذّر تشغيل صوت الرد.');
    } finally {
      replyPlaybackActive = false;
      updateDiscussAudioBtn();
    }
  }

  function stopReplyAudio() {
    replyPlaybackActive = false;
    stopAudioHardware();
    updateDiscussAudioBtn();
  }

  // --- Build Floating Dual-Mode Dock UI ---
  const dock = document.createElement('section');
  dock.id = 'voice-ai-dock';
  dock.hidden = true;
  dock.setAttribute('aria-label', 'القارئ الصوتي والمناقشة الذكية');
  dock.innerHTML = `
    <header class="vai-header">
      <div class="vai-tabs" role="tablist">
        <button type="button" class="vai-tab is-active" data-vai-tab="read" role="tab" aria-selected="true">🎧 قراءة</button>
        <button type="button" class="vai-tab" data-vai-tab="discuss" role="tab" aria-selected="false">💬 مناقشة</button>
        <button type="button" class="vai-tab" data-vai-tab="settings" role="tab" aria-selected="false">⚙️ الإعدادات</button>
      </div>
      <div class="vai-header-actions">
        <span class="vai-cost-badge" id="vai-cost-badge">0.00$ مضمون</span>
        <button type="button" class="vai-icon-btn" id="vai-close-btn" aria-label="إغلاق لوحة الصوت والمناقشة" title="إغلاق">✕</button>
      </div>
    </header>
    <div class="vai-body">
      <!-- TAB 1: READING (Chirp 3 HD / Gemini TTS) -->
      <div class="vai-panel" data-vai-panel="read">
        <div class="vai-player-card">
          <div class="vai-controls-row">
            <div class="vai-transport">
              <button type="button" class="vai-play-btn" id="vai-play-btn">▶ استماع للصفحة</button>
              <button type="button" class="vai-circle-btn" id="vai-prev-chunk" title="المقطع السابق" aria-label="المقطع السابق">⏮</button>
              <button type="button" class="vai-circle-btn" id="vai-next-chunk" title="المقطع التالي" aria-label="المقطع التالي">⏭</button>
              <button type="button" class="vai-circle-btn" id="vai-stop-btn" title="إيقاف" aria-label="إيقاف">■</button>
            </div>
            <button type="button" class="vai-switch-pill" id="vai-switch-to-discuss">💬 ناقش الصفحة</button>
          </div>
          <div class="vai-status-line">
            <span class="vai-status-indicator"><span class="vai-live-dot" id="vai-live-dot"></span><span id="vai-read-status">جاهز للقراءة الصوتية.</span></span>
            <span class="vai-chunk-badge" id="vai-chunk-counter"></span>
          </div>
          <div class="vai-chunk-preview" id="vai-chunk-preview">اضغط «استماع للصفحة» لبدء السرد الصوتي المتصل من موضعك الحالي.</div>
        </div>
        <div class="vai-quota-bar-wrap">
          <div class="vai-quota-row">
            <span id="vai-chirp-quota-text">الرصيد المجاني: 0 / 900,000 حرف</span>
            <div class="vai-quota-actions">
              <span id="vai-cache-saved-text">توفير الكاش: 0 حرف</span>
              <button type="button" class="vai-bypass-btn" id="vai-bypass-daily-btn" aria-pressed="false" title="تجاوز الحد اليومي مع إبقاء السقف الشهري الآمن (0$) فعّالًا">⚡ تجاوز الحد اليومي</button>
            </div>
          </div>
          <div class="vai-progress"><div class="vai-progress-fill" id="vai-chirp-bar"></div></div>
        </div>
      </div>

      <!-- TAB 2: DISCUSSION (Gemini Free Tier) -->
      <div class="vai-panel" data-vai-panel="discuss" hidden>
        <div class="vai-controls-row" style="margin-bottom:8px;">
          <span class="vai-hint" id="vai-discuss-quota-text">Gemini المجاني اليوم: 0 / 20 طلب</span>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
            <button type="button" class="vai-bypass-btn" id="vai-discuss-bypass-btn" aria-pressed="false" title="تجاوز الحد اليومي للنقاش">⚡ تجاوز الحد اليومي</button>
            <button type="button" class="vai-secondary-btn" id="vai-stop-reply-audio" hidden>⏹ إيقاف الصوت</button>
            <button type="button" class="vai-switch-pill" id="vai-switch-to-read">🎧 العودة للقراءة</button>
          </div>
        </div>
        <div class="vai-quick-prompts">
          <button type="button" class="vai-chip" data-vai-prompt="لخّص هذه الصفحة في 3 نقاط سريعة.">لخّص الصفحة</button>
          <button type="button" class="vai-chip" data-vai-prompt="ما الفكرة الأساسية التي يريد المؤلف إيصالها هنا؟">الفكرة الرئيسية</button>
          <button type="button" class="vai-chip" data-vai-prompt="اطرح عليّ سؤالًا واحدًا لاختبار فهمي لهذا المقطع.">اختبر فهمي</button>
          <button type="button" class="vai-chip" data-vai-prompt="أعطني مثالًا عمليًا يوضح ما ورد في هذه الصفحة.">مثال عملي</button>
        </div>
        <div class="vai-chat-log" id="vai-chat-log"></div>
        <form class="vai-chat-form" id="vai-chat-form">
          <input type="text" class="vai-chat-input" id="vai-chat-input" placeholder="اسأل Gemini عن هذه الصفحة أو المقطع المحدد...">
          <button type="submit" class="vai-play-btn" id="vai-chat-send">إرسال</button>
        </form>
      </div>

      <!-- TAB 3: SETTINGS & ZERO-COST GUARDRAILS -->
      <div class="vai-panel" data-vai-panel="settings" hidden>
        <div class="vai-settings-grid">
          <p class="vai-hint">تُحفظ المفاتيح محليًا في متصفحك فقط ولا تُرفع لأي مستودع. لضمان <strong>0$ شهريًا</strong>، يتوقف القارئ تلقائيًا عند بلوغ السقف الآمن قبل حدود الباقة المجانية. <a href="docs/GOOGLE-VOICE-SETUP.md" target="_blank" rel="noopener">دليل الإعداد المجاني</a></p>
          <div class="vai-field">
            <label for="vai-set-proxy">رابط الوسيط السحابي (Cloudflare Worker — اختياري)</label>
            <input id="vai-set-proxy" type="url" dir="ltr" placeholder="https://goog-voice-bridge.your-subdomain.workers.dev">
          </div>
          <div class="vai-field">
            <label for="vai-set-tts-key">مفتاح Google Cloud TTS (للقراءة بـ Chirp 3 HD)</label>
            <input id="vai-set-tts-key" type="password" dir="ltr" placeholder="AIza... (اختياري عند استخدام الوسيط)">
          </div>
          <div class="vai-field">
            <label for="vai-set-gemini-key">مفتاح Gemini API المجاني (Google AI Studio — للمناقشة)</label>
            <input id="vai-set-gemini-key" type="password" dir="ltr" placeholder="AIza... (بدون بطاقة بنكية)">
          </div>
          <div class="vai-field">
            <label for="vai-set-engine">محرك القراءة الصوتية</label>
            <select id="vai-set-engine">
              <option value="auto">تلقائي: Chirp 3 HD ← Gemini TTS المجاني</option>
              <option value="chirp3">Google Cloud Chirp 3: HD فقط</option>
              <option value="gemini-tts">Gemini 3.8 Flash-Lite TTS (مجاني دون بطاقة)</option>
            </select>
          </div>
          <div class="vai-field">
            <label for="vai-set-voice">صوت القراءة العربية (Chirp 3: HD)</label>
            <select id="vai-set-voice">${Core.CHIRP3_VOICES.map(v => `<option value="${v.id}">${v.label}</option>`).join('')}</select>
          </div>
          <div class="vai-field">
            <label for="vai-set-model">نموذج المناقشة (Gemini Free Tier)</label>
            <select id="vai-set-model">${Core.GEMINI_MODELS.map(m => `<option value="${m.id}">${m.label}</option>`).join('')}</select>
          </div>
          <div class="vai-field">
            <label for="vai-set-rate">سرعة القراءة (<span id="vai-rate-label">1.0x</span>)</label>
            <input id="vai-set-rate" type="range" min="0.75" max="1.6" step="0.05" value="1">
          </div>
          <label class="vai-check-row"><input type="checkbox" id="vai-set-autoturn">تقليب الصفحة تلقائيًا عند انتهاء قراءتها</label>
          <label class="vai-check-row"><input type="checkbox" id="vai-set-concise">إجابات Gemini مختصرة (توفّر حتى 60% من استهلاك الجلسة المجانية)</label>
          <label class="vai-check-row"><input type="checkbox" id="vai-set-speak-reply">قراءة ردود Gemini صوتيًا تلقائيًا (تستهلك من رصيد الصوت)</label>
          <div class="vai-settings-actions">
            <button type="button" class="vai-play-btn" id="vai-save-settings">حفظ الإعدادات</button>
            <button type="button" class="vai-secondary-btn" id="vai-clear-cache">مسح كاش الصوت</button>
            <button type="button" class="vai-secondary-btn" id="vai-clear-chat">مسح المحادثة</button>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(dock);

  // --- UI Helpers ---
  const elPlayBtn = dock.querySelector('#vai-play-btn');
  const elReadStatus = dock.querySelector('#vai-read-status');
  const elChunkCounter = dock.querySelector('#vai-chunk-counter');
  const elChunkPreview = dock.querySelector('#vai-chunk-preview');
  const elChirpQuotaText = dock.querySelector('#vai-chirp-quota-text');
  const elCacheSavedText = dock.querySelector('#vai-cache-saved-text');
  const elChirpBar = dock.querySelector('#vai-chirp-bar');
  const elDiscussQuotaText = dock.querySelector('#vai-discuss-quota-text');
  const elChatLog = dock.querySelector('#vai-chat-log');
  const elChatInput = dock.querySelector('#vai-chat-input');
  const elChatSend = dock.querySelector('#vai-chat-send');
  const elLiveDot = dock.querySelector('#vai-live-dot');
  const elStopReplyBtn = dock.querySelector('#vai-stop-reply-audio');
  const elBypassDailyBtn = dock.querySelector('#vai-bypass-daily-btn');
  const elDiscussBypassBtn = dock.querySelector('#vai-discuss-bypass-btn');

  function toggleBypassDailyCap() {
    const next = !settings.bypassDailyCap;
    saveSettings({ bypassDailyCap: next });
    setReadStatus(
      next
        ? 'تم تفعيل تجاوز الحد اليومي (مع بقاء السقف الشهري الآمن 0$ فعّالًا).'
        : 'تمت إعادة تفعيل الحد اليومي الآمن.'
    );
  }

  function updateDiscussAudioBtn() {
    if (elStopReplyBtn) elStopReplyBtn.hidden = !replyPlaybackActive;
  }

  function setReadStatus(msg) {
    elReadStatus.textContent = msg;
  }

  function updateReadUI() {
    elPlayBtn.textContent = playback.isPlaying ? '⏸ إيقاف مؤقت' : (playback.isPaused ? '▶ متابعة القراءة' : '▶ استماع للصفحة');
    if (elLiveDot) elLiveDot.classList.toggle('is-playing', playback.isPlaying);
    updateMediaSession(playback.isPlaying);
    if (playback.chunks.length) {
      const idx = Math.min(playback.chunkIndex, playback.chunks.length - 1);
      elChunkCounter.textContent = `مقطع ${idx + 1} / ${playback.chunks.length}`;
      elChunkPreview.textContent = playback.chunks[idx].text;
    } else {
      elChunkCounter.textContent = '';
    }
  }

  function updateDiscussUI() {
    elChatSend.disabled = discussion.busy;
  }

  function renderQuotaUI() {
    const snap = tracker.getSnapshot(Date.now());
    const fmt = n => Number(n || 0).toLocaleString('en-US');
    const bypassed = Boolean(settings.bypassDailyCap);
    const remoteUsage = remoteStatus?.usage;
    const usingGeminiTts = settings.ttsEngine === 'gemini-tts' ||
      (remoteStatus?.secretsConfigured && !remoteStatus.secretsConfigured.googleTts);

    if (usingGeminiTts && remoteUsage) {
      const used = Number(remoteUsage.geminiTtsDailyRequests) || 0;
      const cap = Number(remoteUsage.geminiTtsDailyCap) || 30;
      const pct = Math.min(100, Math.round((used / Math.max(1, cap)) * 100));
      elChirpQuotaText.textContent = bypassed
        ? `Gemini TTS المجاني اليوم: ${used} صفحة (الحد اليومي مفتوح)`
        : `Gemini TTS المجاني اليوم: ${used} / ${cap} صفحة (0.00$)`;
      elCacheSavedText.textContent = `تم توفير: ${fmt(snap.chirpSavedCacheChars + snap.chirpSavedCleanChars)} حرف`;
      elChirpBar.style.width = `${pct}%`;
    } else {
      const usedM = remoteUsage ? Number(remoteUsage.chirpMonthlyChars) : snap.chirpMonthlyChars;
      const capM = remoteUsage ? Number(remoteUsage.chirpMonthlyCap) : snap.safeMonthlyCap;
      const usedD = remoteUsage ? Number(remoteUsage.chirpDailyChars) : snap.chirpDailyChars;
      const capD = remoteUsage ? Number(remoteUsage.chirpDailyCap) : snap.safeDailyCap;
      const pct = Math.min(100, Math.round((usedM / Math.max(1, capM)) * 100));
      const dailyLabel = bypassed ? `${fmt(usedD)} — مفتوح` : `${fmt(usedD)} / ${fmt(capD)}`;
      elChirpQuotaText.textContent = `Chirp 3 HD الشهري: ${fmt(usedM)} / ${fmt(capM)} حرف (اليوم: ${dailyLabel})`;
      elCacheSavedText.textContent = `تم توفير: ${fmt(snap.chirpSavedCacheChars + snap.chirpSavedCleanChars)} حرف`;
      elChirpBar.style.width = `${pct}%`;
    }

    const gemUsed = remoteUsage ? Number(remoteUsage.geminiDailyRequests) : snap.geminiDailyRequests;
    const gemCap = remoteUsage ? Number(remoteUsage.geminiDailyCap) : snap.geminiDailyCap;
    const discussDailyLabel = bypassed ? `${gemUsed} (الحد اليومي مفتوح)` : `${gemUsed} / ${gemCap} طلب`;
    elDiscussQuotaText.textContent = `Gemini المجاني اليوم: ${discussDailyLabel} (توفير الكاش: ${snap.geminiSavedCacheRequests})`;
    [elBypassDailyBtn, elDiscussBypassBtn].forEach(btn => {
      if (!btn) return;
      btn.classList.toggle('is-active', bypassed);
      btn.setAttribute('aria-pressed', String(bypassed));
      btn.textContent = bypassed ? '✓ الحد اليومي مفتوح' : '⚡ تجاوز الحد اليومي';
    });
  }

  function appendChatMessage(role, text, fromCache = false) {
    const div = document.createElement('div');
    div.className = `vai-msg ${role === 'user' ? 'vai-msg-user' : 'vai-msg-model'}`;
    div.textContent = text;
    if (role === 'model' && !text.startsWith('يفكّر')) {
      const actions = document.createElement('div');
      actions.className = 'vai-msg-actions';
      const listenBtn = document.createElement('button');
      listenBtn.type = 'button';
      listenBtn.className = 'vai-secondary-btn';
      listenBtn.textContent = fromCache ? '🔊 استماع (من الكاش)' : '🔊 استماع للرد';
      listenBtn.addEventListener('click', () => speakReplyText(text));
      actions.appendChild(listenBtn);
      div.appendChild(actions);
    }
    elChatLog.appendChild(div);
    elChatLog.scrollTop = elChatLog.scrollHeight;
    return div;
  }

  function switchTab(tabName) {
    if (tabName === 'discuss' && playback.isPlaying) {
      pauseReading();
    }
    dock.classList.toggle('is-expanded', tabName === 'settings' || tabName === 'discuss');
    dock.querySelectorAll('.vai-tab').forEach(btn => {
      const active = btn.dataset.vaiTab === tabName;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    dock.querySelectorAll('.vai-panel').forEach(panel => {
      panel.hidden = panel.dataset.vaiPanel !== tabName;
    });
    if (tabName === 'settings') populateSettingsForm();
    if (tabName === 'discuss') elChatInput.focus();
  }

  function populateSettingsForm() {
    dock.querySelector('#vai-set-proxy').value = settings.proxyUrl || '';
    dock.querySelector('#vai-set-tts-key').value = settings.googleTtsApiKey || '';
    dock.querySelector('#vai-set-gemini-key').value = settings.geminiApiKey || '';
    dock.querySelector('#vai-set-engine').value = settings.ttsEngine || 'auto';
    dock.querySelector('#vai-set-voice').value = settings.chirpVoice;
    dock.querySelector('#vai-set-model').value = settings.geminiModel;
    dock.querySelector('#vai-set-rate').value = settings.speakingRate;
    dock.querySelector('#vai-rate-label').textContent = `${Number(settings.speakingRate).toFixed(2)}x`;
    dock.querySelector('#vai-set-autoturn').checked = !!settings.autoTurnPage;
    dock.querySelector('#vai-set-concise').checked = !!settings.conciseDiscussion;
    dock.querySelector('#vai-set-speak-reply').checked = !!settings.speakDiscussionReplies;
  }

  function openDock(tabName = 'read') {
    dock.hidden = false;
    renderQuotaUI();
    refreshRemoteStatus();
    switchTab(tabName);
    const panel = document.getElementById('reader-tools-panel');
    if (panel) panel.hidden = true;
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && playback.isPlaying && playback.chunks[playback.chunkIndex]) {
      syncVisualPageToChunk(playback.chunks[playback.chunkIndex]);
    }
  });

  // --- Wire Events ---
  dock.querySelectorAll('.vai-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.vaiTab));
  });
  dock.querySelector('#vai-close-btn').addEventListener('click', () => {
    pauseReading();
    dock.hidden = true;
  });
  dock.querySelector('#vai-play-btn').addEventListener('click', togglePlayPause);
  dock.querySelector('#vai-stop-btn').addEventListener('click', () => stopReading(true));
  dock.querySelector('#vai-prev-chunk').addEventListener('click', () => {
    if (!playback.chunks.length) loadCurrentPageChunks();
    playback.chunkIndex = Math.max(0, playback.chunkIndex - 1);
    stopAudioHardware();
    playback.isPlaying = true;
    playback.isPaused = false;
    playCurrentChunk();
  });
  dock.querySelector('#vai-next-chunk').addEventListener('click', () => {
    if (!playback.chunks.length) loadCurrentPageChunks();
    playback.chunkIndex = Math.min(playback.chunks.length - 1, playback.chunkIndex + 1);
    stopAudioHardware();
    playback.isPlaying = true;
    playback.isPaused = false;
    playCurrentChunk();
  });
  dock.querySelector('#vai-switch-to-discuss').addEventListener('click', () => switchTab('discuss'));
  dock.querySelector('#vai-switch-to-read').addEventListener('click', () => {
    stopReplyAudio();
    switchTab('read');
  });
  if (elStopReplyBtn) elStopReplyBtn.addEventListener('click', stopReplyAudio);
  if (elBypassDailyBtn) elBypassDailyBtn.addEventListener('click', toggleBypassDailyCap);
  if (elDiscussBypassBtn) elDiscussBypassBtn.addEventListener('click', toggleBypassDailyCap);

  dock.querySelectorAll('.vai-chip').forEach(chip => {
    chip.addEventListener('click', () => askGemini(chip.dataset.vaiPrompt));
  });
  dock.querySelector('#vai-chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const val = elChatInput.value;
    elChatInput.value = '';
    askGemini(val);
  });

  dock.querySelector('#vai-set-rate').addEventListener('input', (e) => {
    dock.querySelector('#vai-rate-label').textContent = `${Number(e.target.value).toFixed(2)}x`;
  });
  dock.querySelector('#vai-save-settings').addEventListener('click', () => {
    saveSettings({
      proxyUrl: dock.querySelector('#vai-set-proxy').value.trim(),
      googleTtsApiKey: dock.querySelector('#vai-set-tts-key').value.trim(),
      geminiApiKey: dock.querySelector('#vai-set-gemini-key').value.trim(),
      ttsEngine: dock.querySelector('#vai-set-engine').value,
      chirpVoice: dock.querySelector('#vai-set-voice').value,
      geminiModel: dock.querySelector('#vai-set-model').value,
      speakingRate: Number(dock.querySelector('#vai-set-rate').value) || 1,
      autoTurnPage: dock.querySelector('#vai-set-autoturn').checked,
      conciseDiscussion: dock.querySelector('#vai-set-concise').checked,
      speakDiscussionReplies: dock.querySelector('#vai-set-speak-reply').checked
    });
    setReadStatus('تم حفظ الإعدادات بنجاح.');
    switchTab('read');
  });
  dock.querySelector('#vai-clear-cache').addEventListener('click', async () => {
    await cacheClearAll();
    setReadStatus('تم مسح الذاكرة المؤقتة للصوت.');
  });
  dock.querySelector('#vai-clear-chat').addEventListener('click', () => {
    discussion.history = [];
    discussion.cache.clear();
    elChatLog.innerHTML = '';
  });

  // Wire toolbar entry buttons in index.html
  const btnRead = document.getElementById('btn-voice-read');
  const btnDiscuss = document.getElementById('btn-gemini-discuss');
  if (btnRead) btnRead.addEventListener('click', () => openDock('read'));
  if (btnDiscuss) btnDiscuss.addEventListener('click', () => openDock('discuss'));

  // Stop active reading if user manually turns the page while paused
  window.addEventListener('reader-progress-changed', () => {
    if (playback.isPaused && playback.pageNumber !== app.state.currentPage) {
      playback.chunks = [];
      playback.chunkIndex = 0;
    }
  });

  renderQuotaUI();
  window.ReaderVoice = { openDock, switchTab, stopReading, togglePlayPause };
})();
