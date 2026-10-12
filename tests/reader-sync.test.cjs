const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../reader-sync.js'), 'utf8').replaceAll('import(', 'loadSDK(');
const record = (page, changedAt) => ({ page, location: { block: page * 2, offset: 3 }, pause: null, changedAt });
const tick = () => new Promise(resolve => setImmediate(resolve));

async function harness({ local = null, configured = true, page = 1, startupFailure = false } = {}) {
  const storage = new Map(local ? [['reader-sync-pending-test-book', JSON.stringify(local)]] : []);
  const events = {}, timers = new Map(), restored = [], writes = [], status = {};
  let listener, server = null, fail = false, id = 0, loads = 0;
  const snapshot = (value, metadata = {}) => ({ exists: () => value !== null, data: () => value,
    metadata: { fromCache: false, hasPendingWrites: false, ...metadata } });
  const sdk = {
    getFirestore: () => ({}), doc: () => ({ firestore: {} }),
    serverTimestamp: () => 'server-time',
    onSnapshot: (ref, options, callback) => { listener = callback; },
    runTransaction: async (db, callback) => {
      if (fail) throw new Error('offline');
      return callback({ get: async () => snapshot(server), set: (ref, data) => { server = data; writes.push(data); } });
    }
  };
  const window = {
    READER_FIREBASE_CONFIG: configured ? { projectId: 'test' } : null,
    BookLibrary: { ready: Promise.resolve(), activeBook: { id: 'test-book' } },
    LibbyApp: { ready: Promise.resolve(), state: { currentPage: page, readingLocation: null, pauseMarker: null }, restoreProgress: value => restored.push(value) },
    addEventListener: (name, callback) => { events[name] = callback; }
  };
  vm.runInNewContext(source, {
    window, document: { getElementById: () => status, addEventListener() {}, hidden: false },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    location: { protocol: 'https:' }, console: { warn() {} },
    setTimeout: (callback, delay) => { timers.set(++id, { callback, delay }); return id; },
    clearTimeout: key => timers.delete(key),
    loadSDK: async url => {
      loads++;
      if (startupFailure) { startupFailure = false; throw new Error('offline startup'); }
      return url.includes('firebase-app') ? { getApps: () => [], initializeApp: () => ({}) } : sdk;
    }
  });
  await tick();
  return {
    storage, restored, writes, status, get loads() { return loads; },
    edit: value => events['reader-progress-changed']({ detail: value }),
    snapshot: (value, metadata) => { server = value; listener(snapshot(value, metadata)); },
    setServer: value => { server = value; }, setFail: value => { fail = value; },
    async online() { events.online(); await tick(); },
    async flush() {
      const entry = [...timers.entries()].find(([, item]) => item.delay === 800 || item.delay === 15000);
      if (!entry) return;
      timers.delete(entry[0]); await entry[1].callback(); await tick();
    }
  };
}

test('restores semantic progress without uploading initialization or remote changes', async () => {
  const h = await harness();
  h.snapshot(record(19, 100));
  await h.flush();
  assert.equal(h.restored[0].location.block, 38);
  assert.equal(h.restored[0].page, 19);
  assert.equal(h.writes.length, 0);
});

test('publishes genuine reading changes and clears persisted pending data', async () => {
  const h = await harness(); h.snapshot(null);
  h.edit({ page: 7, location: { block: 24, offset: 5 }, pause: null });
  assert.equal(h.storage.size, 1);
  await h.flush();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].location.offset, 5);
  assert.equal(h.writes[0].updatedAt, 'server-time');
  assert.equal(h.storage.size, 0);
});

test('failed writes survive retry and page reload; stale remote progress does not replace them', async () => {
  const h = await harness({ local: record(33, 200) });
  h.snapshot(record(2, 100)); h.setFail(true); await h.flush();
  assert.equal(h.storage.size, 1);
  assert.equal(h.restored.length, 0);
  h.setFail(false); await h.flush();
  assert.equal(h.writes[0].page, 33);
  assert.equal(h.storage.size, 0);
});

test('newer cloud progress supersedes an older pending edit', async () => {
  const h = await harness({ local: record(3, 100) });
  h.snapshot(record(25, 200)); await h.flush();
  assert.equal(h.restored[0].page, 25);
  assert.equal(h.writes.length, 0);
  assert.equal(h.storage.size, 0);
});

test('transaction prevents stale offline progress overwriting a concurrent newer device', async () => {
  const h = await harness({ local: record(3, 100) });
  h.snapshot(record(2, 50)); h.setServer(record(50, 200)); await h.flush();
  assert.equal(h.restored[0].page, 50);
  assert.equal(h.writes.length, 0);
});

test('empty cached snapshots do not upload stale startup state', async () => {
  const h = await harness({ page: 40 });
  h.snapshot(null, { fromCache: true }); await h.flush();
  assert.equal(h.writes.length, 0);
  assert.equal(h.storage.size, 0);
});

test('invalid cloud data and uncommitted snapshots never change the reader', async () => {
  const h = await harness();
  h.snapshot(record(2, 100), { hasPendingWrites: true });
  h.snapshot({ ...record(9, 100), location: { block: -1, offset: 0 } });
  assert.equal(h.restored.length, 0);
});

test('missing cloud configuration preserves local progress without loading SDKs', async () => {
  const h = await harness({ configured: false });
  h.edit({ page: 7, location: null, pause: null });
  assert.equal(h.loads, 0);
  assert.equal(h.storage.size, 1);
});

test('rapid edits receive increasing versions so a prior snapshot cannot erase a bookmark', async () => {
  const h = await harness(); h.snapshot(null);
  h.edit({ page: 9, location: null, pause: null });
  const first = JSON.parse([...h.storage.values()][0]);
  h.edit({ page: 9, location: null, pause: { page: 9, location: null, snippet: 'Chapter', timestamp: Date.now() } });
  const second = JSON.parse([...h.storage.values()][0]);
  assert.ok(second.changedAt > first.changedAt);
  h.snapshot(first); await h.flush();
  assert.equal(h.writes[0].pause.page, 9);
});

test('startup without network reconnects and uploads preserved edits when online', async () => {
  const h = await harness({ startupFailure: true });
  h.edit({ page: 11, location: null, pause: null });
  await h.online();
  h.snapshot(null); await h.flush();
  assert.equal(h.writes[0].page, 11);
  assert.equal(h.storage.size, 0);
});
