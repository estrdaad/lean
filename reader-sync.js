/* Shared personal reading progress, intentionally without authentication. */
(function () {
  'use strict';
  const status = document.getElementById('reader-sync-status');
  const report = message => { status.textContent = message; };
  let pending = null, timer, connected = false, sending = false, documentRef, firestore, lastChanged = 0;
  let initializing = false, retryTimer, unsubscribe;
  const key = () => `reader-sync-pending-${window.BookLibrary.activeBook.id}`;
  const validLocation = value => value === null || (value && Number.isInteger(value.block) && value.block >= 0 &&
    Number.isInteger(value.offset) && value.offset >= 0);
  function valid(value) {
    return value && Number.isInteger(value.page) && value.page > 0 && value.page <= 1000000 &&
      validLocation(value.location) && (value.pause === null || (Number.isInteger(value.pause.page) && value.pause.page > 0 &&
      validLocation(value.pause.location) && typeof value.pause.snippet === 'string' && value.pause.snippet.length <= 1000 &&
      Number.isFinite(value.pause.timestamp))) && Number.isSafeInteger(value.changedAt) && value.changedAt >= 0;
  }
  function remember(value) {
    pending = value;
    lastChanged = Math.max(lastChanged, value.changedAt);
    try { localStorage.setItem(key(), JSON.stringify(value)); } catch (_) { /* In-memory fallback. */ }
  }
  function clearPending() {
    pending = null;
    try { localStorage.removeItem(key()); } catch (_) {}
  }
  function schedule() {
    clearTimeout(timer);
    if (connected && pending) timer = setTimeout(flush, 800);
  }
  window.addEventListener('reader-progress-changed', event => {
    const value = { ...event.detail, changedAt: Math.max(Date.now(), lastChanged + 1) };
    if (!valid(value)) return;
    remember(value);
    if (window.READER_FIREBASE_CONFIG) report(connected ? 'جارٍ حفظ تقدم القراءة…' : 'تقدمك محفوظ محليًا؛ بانتظار اتصال المزامنة.');
    schedule();
  });
  async function flush() {
    clearTimeout(timer);
    if (!connected || !pending || sending) return;
    sending = true;
    const sent = pending;
    try {
      const result = await firestore.runTransaction(documentRef.firestore, async transaction => {
        const existing = await transaction.get(documentRef);
        if (existing.exists() && existing.data().changedAt > sent.changedAt) return existing.data();
        transaction.set(documentRef, {
          page: sent.page, location: sent.location, pause: sent.pause,
          changedAt: sent.changedAt, updatedAt: firestore.serverTimestamp()
        });
        return null;
      });
      if (pending === sent) {
        clearPending();
        if (result && valid(result)) window.LibbyApp.restoreProgress(result);
        report('تمت مزامنة تقدم القراءة بين أجهزتك.');
      }
    } catch (error) {
      report('تعذرت المزامنة. تقدمك محفوظ على هذا الجهاز؛ ستُعاد المحاولة.');
      console.warn('Reading sync unavailable:', error.code || error.message);
      timer = setTimeout(flush, 15000);
    } finally {
      sending = false;
      if (pending && pending !== sent) schedule();
    }
  }
  window.addEventListener('online', () => { if (connected) flush(); else initialize(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  async function initialize() {
    await window.BookLibrary.ready;
    await window.LibbyApp.ready;
    try {
      const saved = JSON.parse(localStorage.getItem(key()) || 'null');
      if (!pending && valid(saved)) { pending = saved; lastChanged = saved.changedAt; }
    } catch (_) {}
    if (!window.READER_FIREBASE_CONFIG) {
      report('تقدمك محفوظ على هذا الجهاز؛ المزامنة بانتظار ربط Firebase.');
      return;
    }
    if (location.protocol === 'file:') {
      report('افتح الموقع عبر رابط الويب لمزامنة تقدم القراءة.');
      return;
    }
    if (initializing) return;
    initializing = true;
    try {
      clearTimeout(retryTimer);
      unsubscribe?.();
      report('جارٍ الاتصال بمزامنة القراءة…');
      const appSDK = await import('https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js');
      firestore = await import('https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js');
      const app = appSDK.getApps()[0] || appSDK.initializeApp(window.READER_FIREBASE_CONFIG);
      const db = firestore.getFirestore(app, window.READER_FIRESTORE_DATABASE || 'reading-progress');
      documentRef = firestore.doc(db, 'readingProgress', window.BookLibrary.activeBook.id);
      report('جارٍ استعادة تقدم القراءة…');
      // A live document listener is needed for immediate cross-device updates.
      unsubscribe = firestore.onSnapshot(documentRef, { includeMetadataChanges: true }, snapshot => {
        if (snapshot.metadata.hasPendingWrites) return;
        if (!snapshot.metadata.fromCache) connected = true;
        if (snapshot.exists()) {
          const remote = snapshot.data();
          if (!valid(remote)) { report('بيانات التقدم السحابية غير صالحة.'); return; }
          lastChanged = Math.max(lastChanged, remote.changedAt);
          if (!pending || remote.changedAt >= pending.changedAt) {
            clearPending();
            window.LibbyApp.restoreProgress(remote);
            report('تمت مزامنة تقدم القراءة بين أجهزتك.');
          }
        } else if (connected && !pending) {
          const state = window.LibbyApp.state;
          if (state.currentPage > 1 || state.pauseMarker) {
            remember({ page: state.currentPage, location: state.readingLocation, pause: state.pauseMarker, changedAt: Date.now() });
          } else report('المزامنة جاهزة؛ سيُحفظ تقدمك عند بدء القراءة.');
        }
        schedule();
      }, error => {
        connected = false;
        report('تعذر الاتصال بالمزامنة. تقدمك محفوظ على هذا الجهاز.');
        console.warn('Reading listener unavailable:', error.code || error.message);
        retryTimer = setTimeout(initialize, 15000);
      });
    } catch (error) {
      report('تعذر تحميل المزامنة. تقدمك محفوظ على هذا الجهاز.');
      console.warn('Reading sync startup failed:', error.code || error.message);
      retryTimer = setTimeout(initialize, 15000);
    } finally {
      initializing = false;
    }
  }
  initialize();
})();
