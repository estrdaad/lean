/* Portable reader-book v1 packages and a device-local IndexedDB library. */
(function () {
  'use strict';
  const DEFAULT_ID = 'lean-startup';
  const MAX_BYTES = 50 * 1024 * 1024;
  let lastLibraryTrigger;
  let database, activeBook, busy = false, defaultBook = window.BUNDLED_READER_BOOK;
  let hostedBooks = [];
  const view = document.getElementById('book-library');
  const status = document.getElementById('library-status');
  const grid = document.getElementById('library-grid');
  const safeImage = value => typeof value === 'string' && /^data:image\/(png|jpeg|webp|gif|avif);base64,[a-z\d+/=\s]+$/i.test(value);
  const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(value);
  const setting = key => { try { return localStorage.getItem(key); } catch (_) { return null; } };
  const storeSetting = (key, value) => localStorage.setItem(key, value);
  const bookKey = (id, name) => `reader-book-${id}-${name}`;
  const report = (message, error = false) => { status.textContent = message; status.classList.toggle('error', error); };

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('reader-library', 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('hosted_cache')) db.createObjectStore('hosted_cache', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('أغلق تبويبات التطبيق الأخرى ثم أعد المحاولة.'));
    });
  }
  function readCachedHosted(id) {
    if (!database || !database.objectStoreNames.contains('hosted_cache')) return Promise.resolve(null);
    return new Promise(resolve => {
      try {
        const req = database.transaction('hosted_cache').objectStore('hosted_cache').get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (_) { resolve(null); }
    });
  }
  function writeCachedHosted(entry) {
    if (!database || !database.objectStoreNames.contains('hosted_cache')) return Promise.resolve();
    return new Promise(resolve => {
      try {
        const tx = database.transaction('hosted_cache', 'readwrite');
        tx.objectStore('hosted_cache').put(entry);
        tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
      } catch (_) { resolve(); }
    });
  }
  function loadBundledFallback() {
    if (window.BUNDLED_READER_BOOK) return Promise.resolve(window.BUNDLED_READER_BOOK);
    return new Promise(resolve => {
      const s = document.createElement('script');
      s.src = 'books/bundled-book.js';
      s.onload = () => resolve(window.BUNDLED_READER_BOOK || null);
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
  }
  function readBooks() {
    if (!database) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      const request = database.transaction('books').objectStore('books').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function writeBooks(books) {
    return new Promise((resolve, reject) => {
      const tx = database.transaction('books', 'readwrite');
      books.forEach(book => tx.objectStore('books').put(book));
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('تعذر حفظ الكتب.'));
    });
  }
  async function allBooks() {
    const map = new Map();
    if (defaultBook) map.set(DEFAULT_ID, defaultBook);
    hostedBooks.forEach(book => { if (!map.has(book.id)) map.set(book.id, book); });
    (await readBooks()).forEach(book => map.set(book.id, book));
    return [...map.values()];
  }
  async function loadBook(book, { allowBackgroundRefresh = true } = {}) {
    if (!book || !book.hostedPath) return book;
    const cached = await readCachedHosted(book.id);
    if (cached && cached.book && cached.hostedPath === book.hostedPath) {
      // Stale-while-revalidate: return instant cached book and check for updates quietly
      if (allowBackgroundRefresh && location.protocol !== 'file:') {
        fetch(book.hostedPath, { method: 'HEAD' }).then(async head => {
          if (!head.ok) return;
          const etag = head.headers.get('etag') || '';
          const lm = head.headers.get('last-modified') || '';
          if ((etag && etag !== cached.etag) || (!etag && lm && lm !== cached.lastModified)) {
            const freshResp = await fetch(book.hostedPath);
            if (!freshResp.ok) return;
            const fresh = validateBook(await freshResp.json());
            if (fresh.id === book.id) {
              await writeCachedHosted({ id: book.id, hostedPath: book.hostedPath, book: fresh, etag, lastModified: lm, cachedAt: Date.now() });
            }
          }
        }).catch(() => {});
      }
      return cached.book;
    }
    const response = await fetch(book.hostedPath);
    if (!response.ok) throw new Error('تعذر تحميل الكتاب من المستودع.');
    const loaded = validateBook(await response.json());
    if (loaded.id !== book.id) throw new Error('معرّف الكتاب لا يطابق فهرس المستودع.');
    await writeCachedHosted({
      id: book.id,
      hostedPath: book.hostedPath,
      book: loaded,
      etag: response.headers.get('etag') || '',
      lastModified: response.headers.get('last-modified') || '',
      cachedAt: Date.now()
    });
    return loaded;
  }

  // Preserve semantic HTML, tables, inline formatting and vector illustrations,
  // while excluding executable content, remote resources and app-owned IDs.
  function sanitizeContent(html, assets) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const allowed = new Set('p div section aside header footer figure figcaption h1 h2 h3 h4 h5 h6 span a strong b em i u s small sup sub br hr blockquote pre code bdi bdo ol ul li table caption thead tbody tfoot tr th td img svg g path circle ellipse rect line polyline polygon text tspan defs linearGradient radialGradient stop clipPath title desc'.toLowerCase().split(' '));
    const attributes = new Set('id class style title lang dir role tabindex aria-label aria-hidden href target rel src alt width height loading colspan rowspan scope start value type viewbox fill stroke stroke-width stroke-linecap stroke-linejoin d x y x1 y1 x2 y2 cx cy r rx ry points transform opacity fill-opacity stroke-opacity xmlns offset stop-color stop-opacity preserveaspectratio clip-path fill-rule text-anchor dominant-baseline font-size font-family font-weight textlength lengthadjust gradientunits gradienttransform spreadmethod patternunits patterncontentunits marker-start marker-mid marker-end stroke-dasharray stroke-dashoffset data-footnote-number data-note-number data-note-section data-note-chapter data-chapter'.split(' '));
    const ids = new Set();
    for (const element of [...doc.body.querySelectorAll('*')]) {
      if (!allowed.has(element.tagName.toLowerCase())) { element.remove(); continue; }
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase(), value = attribute.value.trim();
        if (!attributes.has(name)) { element.removeAttribute(attribute.name); continue; }
        if (name === 'style') {
          // Imported CSS cannot fetch files or execute code. Keep local typography/layout.
          const permitted = new Set('color background-color font-weight font-style text-decoration text-align direction unicode-bidi font-size line-height letter-spacing vertical-align white-space border border-color border-width border-style border-collapse padding margin width height max-width max-height display break-before break-after break-inside page-break-before page-break-after page-break-inside'.split(' '));
          const css = document.createElement('span'); css.style.cssText = value;
          for (const property of Array.from(css.style)) {
            if (!permitted.has(property) || /url\s*\(|expression|javascript|@import|var\s*\(/i.test(css.style.getPropertyValue(property))) css.style.removeProperty(property);
          }
          element.setAttribute('style', css.style.cssText);
        }
        if (name === 'href' && !/^(#[a-zA-Z0-9_.:-]+|https?:\/\/|mailto:)/i.test(value)) element.removeAttribute('href');
        if (name === 'src') {
          const image = assets[value] || value;
          if (!safeImage(image)) throw new Error('توجد صورة غير مضمنة. أضف الصور إلى assets بصيغة data URI.');
        }
        if (/url\s*\(/i.test(value) && name !== 'style' && !/^url\(#[a-zA-Z0-9_.:-]+\)$/.test(value)) element.removeAttribute(attribute.name);
      }
      if (element.id) {
        if (!safeId(element.id) || ids.has(element.id) || (document.getElementById(element.id) && (element.id === 'book-article' || !document.getElementById(element.id).closest('#book-article')))) {
          throw new Error('يوجد معرّف مكرر أو يتعارض مع واجهة التطبيق: ' + element.id);
        }
        ids.add(element.id);
      }
      if (element.tagName.toLowerCase() === 'a') element.setAttribute('rel', 'noopener noreferrer');
    }
    for (const link of doc.body.querySelectorAll('a[href^="#"]')) {
      if (!ids.has(link.getAttribute('href').slice(1))) throw new Error('إحالة داخلية لا تملك موضعًا مطابقًا: ' + link.getAttribute('href'));
    }
    if (!doc.body.textContent.trim() && !doc.body.querySelector('img,svg')) throw new Error('محتوى الكتاب فارغ.');
    return { html: doc.body.innerHTML, ids };
  }
  function validateBook(input) {
    if (!input || input.format !== 'reader-book' || input.version !== 1) throw new Error('الملف ليس كتابًا بصيغة reader-book بالإصدار 1.');
    if (!safeId(input.id) || typeof input.title !== 'string' || !input.title.trim() || typeof input.author !== 'string' || typeof input.contentHtml !== 'string') throw new Error('بيانات الكتاب الأساسية ناقصة أو غير صحيحة.');
    if (typeof input.title !== 'string' || input.title.length > 300 || input.author.length > 300) throw new Error('عنوان الكتاب أو اسم المؤلف غير صحيح.');
    const assets = Object.create(null);
    if (!input.assets || typeof input.assets !== 'object' || Array.isArray(input.assets)) throw new Error('حقل assets غير صحيح.');
    for (const [name, image] of Object.entries(input.assets)) {
      if (!safeImage(image)) throw new Error('صيغة إحدى الصور غير مدعومة. استخدم PNG أو JPEG أو WebP أو GIF أو AVIF.');
      assets[name] = image;
    }
    if (input.cover && !safeImage(assets[input.cover] || input.cover)) throw new Error('صورة الغلاف غير مضمنة.');
    const content = sanitizeContent(input.contentHtml, assets);
    if (!Array.isArray(input.toc) || input.toc.some(item => !item || !content.ids.has(item.id) || typeof item.title !== 'string')) throw new Error('الفهرس يحتوي عنوانًا بلا موضع مطابق في الكتاب.');
    return {
      format: 'reader-book', version: 1, id: input.id, title: input.title.trim(), author: input.author,
      language: /^[a-z]{2,3}(-[a-zA-Z]{2,8})?$/.test(input.language || '') ? input.language : 'ar',
      direction: input.direction === 'ltr' ? 'ltr' : 'rtl', sourcePages: Number.isInteger(input.sourcePages) && input.sourcePages > 0 ? input.sourcePages : null,
      description: typeof input.description === 'string' ? input.description.slice(0, 1000) : '',
      cover: input.cover || '', assets, toc: input.toc.map(item => ({ id: item.id, title: item.title.slice(0, 300) })), contentHtml: content.html
    };
  }
  function hydrateBook(book) {
    const article = document.getElementById('book-article');
    article.innerHTML = book.contentHtml;
    article.dir = book.direction;
    document.body.dataset.bookDirection = book.direction;
    article.lang = book.language;
    article.querySelectorAll('img').forEach(image => {
      image.loading = 'lazy';
      image.decoding = 'async';
      image.src = book.assets[image.getAttribute('src')] || image.getAttribute('src');
    });
    const cover = document.querySelector('.cover-main-img');
    const coverSource = book.assets[book.cover] || book.cover;
    cover.hidden = !coverSource;
    if (coverSource) cover.src = coverSource; else cover.removeAttribute('src');
    cover.alt = `غلاف ${book.title}`;
    document.querySelector('.cover-book-title').textContent = book.title;
    document.querySelector('.cover-book-author').textContent = book.author;
    document.querySelector('.cover-book-badge').textContent = book.description || (book.sourcePages ? `${book.sourcePages} صفحة في المصدر` : 'من مكتبتك');
    document.querySelector('.hud-book-name').textContent = book.title;
    document.title = `${book.title} — المكتبة`;
  }
  function migrateOldProgress() {
    if (activeBook.id !== DEFAULT_ID || setting('reader-progress-migrated-v1')) return;
    for (const name of ['page', 'bookmarks', 'pause']) {
      const key = bookKey(DEFAULT_ID, name), old = setting('libby-lean-' + name);
      if (setting(key) === null && old !== null) { try { storeSetting(key, old); } catch (_) {} }
    }
    try { storeSetting('reader-progress-migrated-v1', '1'); } catch (_) {}
  }
  function download(value, filename) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  function button(label, action) {
    const element = document.createElement('button'); element.type = 'button'; element.className = 'library-button'; element.textContent = label; element.onclick = action; return element;
  }
  async function renderLibrary() {
    grid.replaceChildren();
    for (const book of await allBooks()) {
      const card = document.createElement('article'); card.className = 'library-card';
      const image = document.createElement('img'); const source = book.assets[book.cover] || book.cover;
      image.src = source || 'vendor/reader-book.svg'; image.alt = source ? `غلاف ${book.title}` : '';
      if (!source) image.className = 'library-cover-placeholder';
      const title = document.createElement('h2');
      const open = button(book.title, () => {
        if (busy) return;
        if (book.id === activeBook.id && book.contentHtml === activeBook.contentHtml) { closeLibrary(); window.LibbyApp.openCover(); return; }
        try {
          storeSetting('reader-active-book', book.id);
          const nextURL = new URL(location.href);
          for (const key of ['book', 'chapter', 'block', 'offset']) nextURL.searchParams.delete(key);
          nextURL.hash = '';
          history.replaceState(null, '', nextURL.pathname + nextURL.search);
          location.reload();
        } catch (_) { report('تعذر حفظ اختيار الكتاب في هذا المتصفح.', true); }
      });
      open.className = 'library-card-open'; title.append(open);
      const author = document.createElement('p'); author.textContent = book.author;
      const progress = document.createElement('p'); progress.className = 'library-progress';
      const page = Number(setting(bookKey(book.id, 'page'))) || 1;
      progress.textContent = page > 1 ? `آخر موضع قراءة: ص. ${page}` : 'جاهز للقراءة';
      const actions = document.createElement('div'); actions.className = 'library-card-actions';
      actions.append(button('PDF', async () => {
        try { await window.BookPDF.open(await loadBook(book)); }
        catch (error) { report(error.message, true); }
      }));
      card.append(image, title, author, progress, actions); grid.append(card);
    }
  }
  function closeLibrary() { view.hidden = true; lastLibraryTrigger?.focus(); }
  async function openLibrary() {
    lastLibraryTrigger = document.activeElement;
    view.hidden = false;
    document.querySelectorAll('.modal-backdrop').forEach(modal => modal.classList.remove('is-open'));
    document.getElementById('reader-tools-panel').hidden = true;
    document.getElementById('reader-tools-toggle').setAttribute('aria-expanded', 'false');
    try { await renderLibrary(); } catch (_) { report('تعذر قراءة المكتبة. حاول إعادة فتح الصفحة.', true); }
    document.getElementById('library-close').focus();
  }
  async function importFiles(files) {
    if (busy || !files.length) return;
    busy = true; report('جارٍ إضافة الكتب…');
    try {
      const books = [];
      for (const file of files) {
        if (file.size > MAX_BYTES) throw new Error('حجم الملف أكبر من 50 ميجابايت: ' + file.name);
        const data = JSON.parse(await file.text());
        if (data.format === 'reader-library' && data.version === 1 && Array.isArray(data.books)) data.books.forEach(book => books.push(validateBook(book)));
        else books.push(validateBook(data));
      }
      if (!books.length || books.length > 100 || new Set(books.map(book => book.id)).size !== books.length) throw new Error('المجموعة فارغة أو تحتوي معرّفات كتب مكررة أو أكثر من 100 كتاب.');
      await writeBooks(books);
      report(`تم حفظ ${books.length} كتاب. إذا كان الكتاب موجودًا، حُدّث محتواه مع الاحتفاظ بموضع القراءة.`);
      await renderLibrary();
    } catch (error) {
      report(error.name === 'QuotaExceededError' ? 'مساحة التخزين غير كافية. صدّر مكتبتك للاحتفاظ بنسخة منها.' : 'تعذر الاستيراد: ' + error.message, true);
    } finally { busy = false; document.getElementById('library-files').value = ''; }
  }
  async function initialize() {
    const requestedBook = new URLSearchParams(location.search).get('book');
    const desiredId = requestedBook || setting('reader-active-book') || DEFAULT_ID;

    try { database = await openDatabase(); } catch (_) { report('تخزين الكتب غير متاح في هذا المتصفح. يمكنك قراءة الكتاب المرفق وتصديره.', true); document.getElementById('library-import').disabled = true; }

    // Fast path: if the desired book is already cached locally in IndexedDB, open it immediately!
    const localBooks = database ? await readBooks().catch(() => []) : [];
    const localMatch = localBooks.find(b => b.id === desiredId);
    const cachedHosted = !localMatch ? await readCachedHosted(desiredId) : null;

    if (location.protocol !== 'file:') {
      const catalogPromise = fetch('books/catalog.json')
        .then(r => (r.ok ? r.json() : []))
        .then(catalog => {
          hostedBooks = catalog.filter(book => safeId(book.id) && typeof book.title === 'string' && typeof book.author === 'string' && /^books\/[a-zA-Z0-9_-]+\.json$/.test(book.path))
            .map(book => ({ ...book, hostedPath: book.path, assets: {}, cover: '' }));
          if (!hostedBooks.some(b => b.id === DEFAULT_ID)) {
            hostedBooks.unshift({ id: DEFAULT_ID, title: 'الشركة الناشئة المرنة', author: 'إريك ريس', hostedPath: 'books/lean-startup.json', assets: {}, cover: '' });
          }
        })
        .catch(() => {
          hostedBooks = [{ id: DEFAULT_ID, title: 'الشركة الناشئة المرنة', author: 'إريك ريس', hostedPath: 'books/lean-startup.json', assets: {}, cover: '' }];
        });

      if (localMatch) {
        activeBook = localMatch;
        catalogPromise.catch(() => {});
      } else if (cachedHosted && cachedHosted.book) {
        activeBook = cachedHosted.book;
        // Refresh catalog and check for book updates quietly in the background
        catalogPromise.then(() => {
          const entry = hostedBooks.find(b => b.id === activeBook.id);
          if (entry) loadBook(entry, { allowBackgroundRefresh: true }).catch(() => {});
        }).catch(() => {});
      } else {
        await catalogPromise;
        const target = hostedBooks.find(b => b.id === desiredId) || hostedBooks[0];
        try {
          activeBook = await loadBook(target);
        } catch (error) {
          defaultBook = await loadBundledFallback();
          activeBook = defaultBook;
          report(error.message, true);
        }
      }
    } else {
      defaultBook = await loadBundledFallback();
      activeBook = localMatch || defaultBook;
    }

    if (!defaultBook && activeBook && activeBook.id === DEFAULT_ID) defaultBook = activeBook;
    hydrateBook(activeBook); migrateOldProgress();
    document.querySelectorAll('[data-open-library]').forEach(element => element.addEventListener('click', openLibrary));
    document.getElementById('library-close').onclick = closeLibrary;
    document.getElementById('library-import').onclick = () => document.getElementById('library-files').click();
    document.getElementById('library-files').onchange = event => importFiles([...event.target.files]);
    document.getElementById('library-export').onclick = async () => {
      try { download({ format: 'reader-library', version: 1, books: await Promise.all((await allBooks()).map(loadBook)) }, 'reader-library.json'); report('تم تجهيز ملف المكتبة للتنزيل.'); }
      catch (_) { report('تعذر تصدير المكتبة.', true); }
    };
    view.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeLibrary();
      if (event.key === 'Tab') {
        const controls = [...view.querySelectorAll('button:not(:disabled)')];
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
  }
  window.BookLibrary = { get activeBook() { return activeBook; }, open: openLibrary };
  window.BookLibrary.ready = initialize();
})();
