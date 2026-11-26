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

  const STORAGE_SETTINGS = 'goog-reader-voice-settings-v1';
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
      autoTurnPage: true,
      fallbackToBrowserSpeech: true,
      conciseDiscussion: true,
      speakDiscussionReplies: false       // Off by default to save Chirp 3 HD quota
    };
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_SETTINGS) || '{}');
      return { ...defaults, ...saved };
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
    const paragraphs = getVisiblePageParagraphs();
    return paragraphs.map(p => p.text).join('\n').slice(0, Core.LIMITS.GEMINI_MAX_CONTEXT_CHARS);
  }

  // --- Audio Synthesis Backends (Chirp 3 HD + Free Browser Fallback) ---
  let activeAudio = null;
  let activeAudioUrl = null;
  let activeAbort = null;
  let prefetchMap = new Map(); // cacheKey -> Promise<Blob>

  function base64ToAudioBlob(base64, mime = 'audio/mpeg') {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  async function synthesizeChirp3(text, signal) {
    const voice = settings.chirpVoice || Core.CHIRP3_VOICES[0].id;
    const rate = Number(settings.speakingRate) || 1.0;
    const cacheKey = Core.makeAudioCacheKey('chirp3', voice, rate, text);

    const cached = await cacheGetAudio(cacheKey);
    if (cached) {
      persistQuota(tracker.recordChirpCacheHit(text.length));
      renderQuotaUI();
      return { blob: cached, source: 'cache', engine: 'chirp3' };
    }

    const check = tracker.canSpendChirp(text.length, Date.now(), true);
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
        body: JSON.stringify({ text, voice, speakingRate: rate }),
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
      const err = new Error(`خطأ Chirp 3 HD (${response.status}): ${errText.slice(0, 140)}`);
      err.code = response.status === 429 ? 'QUOTA_GUARD' : 'API_ERROR';
      throw err;
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

    persistQuota(tracker.recordChirpSpend(text.length));
    renderQuotaUI();
    await cachePutAudio(cacheKey, blob);
    return { blob, source: 'network', engine: 'chirp3' };
  }

  async function synthesizeGeminiTts(text, signal) {
    const voice = (settings.chirpVoice || Core.CHIRP3_VOICES[0].id).replace(/^ar-XA-Chirp3-HD-/, '');
    const cacheKey = Core.makeAudioCacheKey('gemini-tts', voice, 1.0, text);

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
        body: JSON.stringify({ text, voice }),
        signal
      });
    } else {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-lite-tts:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `اقرأ النص العربي التالي بوضوح ونبرة هادئة دون تعليق:\n${text}` }] }],
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
      const err = new Error(`خطأ Gemini TTS (${response.status}): ${errText.slice(0, 120)}`);
      err.code = response.status === 429 ? 'QUOTA_GUARD' : 'API_ERROR';
      throw err;
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
      if (err.name === 'AbortError') throw err;
      return synthesizeGeminiTts(text, signal);
    }
  }

  function speakWithBrowserSpeech(text, rate = 1.0) {
    return new Promise((resolve, reject) => {
      if (!('speechSynthesis' in window)) {
        return reject(new Error('المتصفح لا يدعم القراءة الصوتية المدمجة.'));
      }
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = 'ar-SA';
      utter.rate = Math.min(2, Math.max(0.6, Number(rate) || 1));
      const voices = window.speechSynthesis.getVoices();
      const arVoice = voices.find(v => /^ar/i.test(v.lang));
      if (arVoice) utter.voice = arVoice;
      utter.onend = () => resolve();
      utter.onerror = (e) => {
        if (e.error === 'interrupted' || e.error === 'canceled') resolve();
        else reject(new Error('تعذّر تشغيل صوت المتصفح.'));
      };
      window.speechSynthesis.speak(utter);
    });
  }

  // --- Playback State Machine (Reading Mode) ---
  const playback = {
    isPlaying: false,
    isPaused: false,
    chunks: [],
    chunkIndex: 0,
    pageNumber: 1,
    activeEngine: 'chirp3'
  };

  function stopAudioHardware() {
    if (activeAbort) { activeAbort.abort(); activeAbort = null; }
    if (activeAudio) {
      activeAudio.pause();
      activeAudio.src = '';
      activeAudio = null;
    }
    if (activeAudioUrl) {
      URL.revokeObjectURL(activeAudioUrl);
      activeAudioUrl = null;
    }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
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
    } else if ('speechSynthesis' in window && window.speechSynthesis.speaking) {
      window.speechSynthesis.pause();
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
    if ('speechSynthesis' in window && window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
      updateReadUI();
      return;
    }
    playCurrentChunk();
  }

  function prefetchNextChunk() {
    if (!playback.isPlaying) return;
    const nextIdx = playback.chunkIndex + 1;
    if (nextIdx >= playback.chunks.length) return;
    const nextText = playback.chunks[nextIdx].text;
    const key = Core.makeAudioCacheKey('chirp3', settings.chirpVoice, settings.speakingRate, nextText);
    if (prefetchMap.has(key)) return;
    // Only prefetch if credentials exist and quota allows
    const check = tracker.canSpendChirp(nextText.length, Date.now(), true);
    if (!check.allowed || (!settings.proxyUrl && !settings.googleTtsApiKey)) return;
    const ctrl = new AbortController();
    const p = synthesizeChirp3(nextText, ctrl.signal).catch(() => null);
    prefetchMap.set(key, p);
  }

  async function playCurrentChunk() {
    if (!playback.isPlaying) return;
    if (playback.chunkIndex >= playback.chunks.length) {
      if (settings.autoTurnPage && app.state.currentPage < app.state.totalPages) {
        app.nextPage();
        await new Promise(r => setTimeout(r, 320));
        if (!playback.isPlaying) return;
        loadCurrentPageChunks();
        if (playback.chunks.length) return playCurrentChunk();
      }
      stopReading(true);
      setReadStatus('انتهت قراءة الصفحة الحالية.');
      return;
    }

    const chunk = playback.chunks[playback.chunkIndex];
    updateReadUI();
    setReadStatus('جارٍ تجهيز الصوت (Chirp 3 HD)...');

    try {
      activeAbort = new AbortController();
      const key = Core.makeAudioCacheKey('chirp3', settings.chirpVoice, settings.speakingRate, chunk.text);
      const pendingPrefetch = prefetchMap.get(key);
      const result = (pendingPrefetch && (await pendingPrefetch)) || (await synthesizeSelectedEngine(chunk.text, activeAbort.signal));
      if (!playback.isPlaying) return;

      playback.activeEngine = result.engine;
      const engineName = result.engine === 'gemini-tts' ? 'Gemini 3.8 Flash-Lite TTS' : 'Chirp 3 HD';
      setReadStatus(result.source === 'cache'
        ? `يقرأ الآن: ${engineName} (من الذاكرة المؤقتة — 0 استهلاك)`
        : `يقرأ الآن: ${engineName} (0$ ضمن الباقة المجانية)`);

      activeAudioUrl = URL.createObjectURL(result.blob);
      activeAudio = new Audio(activeAudioUrl);
      activeAudio.onended = () => {
        if (!playback.isPlaying) return;
        playback.chunkIndex += 1;
        playCurrentChunk();
      };
      activeAudio.onerror = () => {
        if (!playback.isPlaying) return;
        stopReading(false);
        setReadStatus('تعذّر تشغيل المقطع الصوتي.');
      };
      await activeAudio.play();
      // Lazy 1-chunk prefetch only after playback actually begins
      prefetchNextChunk();
    } catch (err) {
      if (err.name === 'AbortError' || !playback.isPlaying) return;
      if (settings.fallbackToBrowserSpeech) {
        playback.activeEngine = 'browser';
        setReadStatus(`${err.message} — تم التحويل تلقائيًا لصوت المتصفح المجاني.`);
        try {
          await speakWithBrowserSpeech(chunk.text, settings.speakingRate);
          if (!playback.isPlaying) return;
          playback.chunkIndex += 1;
          playCurrentChunk();
        } catch (fallbackErr) {
          stopReading(false);
          setReadStatus(fallbackErr.message);
        }
      } else {
        stopReading(false);
        setReadStatus(err.message);
      }
    }
  }

  function loadCurrentPageChunks() {
    const paragraphs = getVisiblePageParagraphs();
    const { chunks, totalSavedByClean } = Core.chunkParagraphs(paragraphs);
    if (totalSavedByClean > 0) {
      persistQuota(tracker.recordCleanSavings(totalSavedByClean));
      renderQuotaUI();
    }
    playback.chunks = chunks;
    playback.chunkIndex = 0;
    playback.pageNumber = app.state.currentPage;
  }

  function togglePlayPause() {
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

    const book = window.BookLibrary.activeBook;
    const excerpt = getCurrentExcerptForDiscussion();
    const cacheKey = Core.hashKey(`${book.id}|${settings.geminiModel}|${excerpt.slice(0, 300)}|${q}`);

    appendChatMessage('user', q);

    if (discussion.cache.has(cacheKey)) {
      persistQuota(tracker.recordGeminiCacheHit());
      renderQuotaUI();
      const cachedReply = discussion.cache.get(cacheKey);
      appendChatMessage('model', cachedReply, true);
      return;
    }

    const check = tracker.canSpendGemini(Date.now());
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
          body: JSON.stringify({ model: settings.geminiModel, payload })
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

  async function speakReplyText(text) {
    stopAudioHardware();
    const clean = Core.cleanTextForTTS(text).text.slice(0, Core.LIMITS.CHUNK_MAX_CHARS);
    if (!clean) return;
    try {
      const res = await synthesizeChirp3(clean);
      activeAudioUrl = URL.createObjectURL(res.blob);
      activeAudio = new Audio(activeAudioUrl);
      await activeAudio.play();
    } catch {
      if (settings.fallbackToBrowserSpeech) {
        speakWithBrowserSpeech(clean, settings.speakingRate).catch(() => {});
      }
    }
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
      <!-- TAB 1: READING (Chirp 3 HD) -->
      <div class="vai-panel" data-vai-panel="read">
        <div class="vai-controls-row">
          <div class="vai-transport">
            <button type="button" class="vai-play-btn" id="vai-play-btn">▶ استماع للصفحة</button>
            <button type="button" class="vai-secondary-btn" id="vai-prev-chunk" title="المقطع السابق">السابق</button>
            <button type="button" class="vai-secondary-btn" id="vai-next-chunk" title="المقطع التالي">التالي</button>
            <button type="button" class="vai-secondary-btn" id="vai-stop-btn" title="إيقاف">■</button>
          </div>
          <button type="button" class="vai-secondary-btn" id="vai-switch-to-discuss">انتقل للمناقشة ←</button>
        </div>
        <div class="vai-status-line">
          <span id="vai-read-status">جاهز للقراءة عبر Google Chirp 3 HD.</span>
          <span id="vai-chunk-counter"></span>
        </div>
        <div class="vai-chunk-preview" id="vai-chunk-preview">اضغط «استماع للصفحة» لبدء القراءة الصوتية من موضعك الحالي.</div>
        <div class="vai-quota-bar-wrap">
          <div class="vai-quota-row">
            <span id="vai-chirp-quota-text">Chirp 3 HD الشهري: 0 / 900,000 حرف</span>
            <span id="vai-cache-saved-text">توفير الكاش: 0 حرف</span>
          </div>
          <div class="vai-progress"><div class="vai-progress-fill" id="vai-chirp-bar"></div></div>
        </div>
      </div>

      <!-- TAB 2: DISCUSSION (Gemini Free Tier) -->
      <div class="vai-panel" data-vai-panel="discuss" hidden>
        <div class="vai-controls-row" style="margin-bottom:8px;">
          <span class="vai-hint" id="vai-discuss-quota-text">Gemini المجاني اليوم: 0 / 20 طلب</span>
          <button type="button" class="vai-secondary-btn" id="vai-switch-to-read">← العودة للقراءة الصوتية</button>
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
              <option value="auto">تلقائي: Chirp 3 HD ← Gemini TTS المجاني ← المتصفح</option>
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
          <label class="vai-check-row"><input type="checkbox" id="vai-set-fallback">التحويل تلقائيًا لصوت المتصفح المجاني عند بلوغ الحد الآمن أو انقطاع الشبكة</label>
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

  function setReadStatus(msg) {
    elReadStatus.textContent = msg;
  }

  function updateReadUI() {
    elPlayBtn.textContent = playback.isPlaying ? '⏸ إيقاف مؤقت' : (playback.isPaused ? '▶ متابعة القراءة' : '▶ استماع للصفحة');
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
    const pct = Math.min(100, Math.round((snap.chirpMonthlyChars / snap.safeMonthlyCap) * 100));
    elChirpQuotaText.textContent = `Chirp 3 HD الشهري: ${fmt(snap.chirpMonthlyChars)} / ${fmt(snap.safeMonthlyCap)} حرف (اليوم: ${fmt(snap.chirpDailyChars)} / ${fmt(snap.safeDailyCap)})`;
    elCacheSavedText.textContent = `تم توفير: ${fmt(snap.chirpSavedCacheChars + snap.chirpSavedCleanChars)} حرف`;
    elChirpBar.style.width = `${pct}%`;
    elDiscussQuotaText.textContent = `Gemini المجاني اليوم: ${snap.geminiDailyRequests} / ${snap.geminiDailyCap} طلب (توفير الكاش: ${snap.geminiSavedCacheRequests})`;
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
    dock.querySelector('#vai-set-fallback').checked = !!settings.fallbackToBrowserSpeech;
    dock.querySelector('#vai-set-autoturn').checked = !!settings.autoTurnPage;
    dock.querySelector('#vai-set-concise').checked = !!settings.conciseDiscussion;
    dock.querySelector('#vai-set-speak-reply').checked = !!settings.speakDiscussionReplies;
  }

  function openDock(tabName = 'read') {
    dock.hidden = false;
    renderQuotaUI();
    switchTab(tabName);
    const panel = document.getElementById('reader-tools-panel');
    if (panel) panel.hidden = true;
  }

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
  dock.querySelector('#vai-switch-to-read').addEventListener('click', () => switchTab('read'));

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
      fallbackToBrowserSpeech: dock.querySelector('#vai-set-fallback').checked,
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
