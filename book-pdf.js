/* Browser-native PDF printing keeps Arabic text and vector figures selectable. */
(function () {
  'use strict';
  const dialog = document.getElementById('pdf-dialog');
  const form = document.getElementById('pdf-settings');
  const frame = document.getElementById('pdf-preview');
  const save = document.getElementById('pdf-save');
  const status = document.getElementById('pdf-status');
  const breaks = document.getElementById('pdf-chapter-breaks');
  const fonts = {
    book: '"Book Arabic", Tahoma, sans-serif', rounded: '"Book Arabic Rounded", Tahoma, sans-serif',
    amiri: '"Amiri", serif', noto: '"Noto Naskh Arabic", serif',
    cairo: '"Cairo", sans-serif', tajawal: '"Tajawal", sans-serif'
  };
  const papers = { A4: [210, 297], A5: [148, 210], Letter: [215.9, 279.4] };
  let book, previewReady = false, revision = 0;
  const bounded = (value, min, max, fallback) => Math.min(max, Math.max(min, Number(value) || fallback));
  function preferences() {
    const values = new FormData(form);
    return {
      font: fonts[values.get('font')] ? values.get('font') : 'book',
      fontSize: bounded(values.get('fontSize'), 10, 26, 14),
      lineHeight: bounded(values.get('lineHeight'), 1.4, 2.2, 1.85),
      margin: bounded(values.get('margin'), 10, 30, 18),
      paper: papers[values.get('paper')] ? values.get('paper') : 'A4',
      chapterStart: ['continuous', 'page', 'right'].includes(values.get('chapterStart')) ? values.get('chapterStart') : 'page',
      titlePage: values.has('titlePage'),
      starts: [...breaks.querySelectorAll('input:checked')].map(input => input.value)
    };
  }
  function applyPreferences() {
    if (!previewReady) return;
    const settings = preferences(), doc = frame.contentDocument;
    const [width, height] = papers[settings.paper];
    const scale = Math.min(1, Math.max(.25, (frame.clientWidth - 8) / (width * 96 / 25.4)));
    doc.getElementById('pdf-layout').textContent = `
      @page { size: ${settings.paper}; margin: ${settings.margin}mm; }
      :root { --font-size: ${settings.fontSize}pt; --ink: #222; --muted: #666; --paper: #fff; --line: #ddd; --accent: #174b43; }
      html, body { margin: 0; background: #fff; color: #222; font-family: ${fonts[settings.font]}; font-size: ${settings.fontSize}pt; line-height: ${settings.lineHeight}; }
      body { padding: ${settings.margin}mm; }
      main { width: ${width - 2 * settings.margin}mm; margin: auto; }
      #pdf-content { padding: 0; margin: 0; column-count: auto; border: 0; }
      #pdf-content * { font-family: inherit !important; }
      #pdf-content p, #pdf-content li { font-size: 1em !important; line-height: inherit !important; }
      h1, h2, h3, h4, .chapter-marker, .display-heading { break-after: avoid; page-break-after: avoid; }
      p { orphans: 3; widows: 3; }
      table { width: 100%; border-collapse: collapse; font-size: .85em; }
      th, td { overflow-wrap: anywhere; padding: .35em; border-bottom: 1px solid #ddd; }
      thead { display: table-header-group; }
      tr, figure { break-inside: avoid; }
      img, svg { max-width: 100%; height: auto; }
      figure img { max-height: ${height - 2 * settings.margin - 25}mm; object-fit: contain; }
      .pdf-title-page { min-height: ${height - 2 * settings.margin - 2}mm; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; break-after: page; }
      .pdf-title-page[hidden] { display: none; }
      .pdf-title-page img { width: auto; max-width: 65%; max-height: ${Math.min(130, height * .4)}mm; object-fit: contain; }
      .pdf-title-page h1 { font-size: 1.8em; line-height: 1.5; margin: 1em 0 .2em; }
      .pdf-title-page p { text-align: center; margin: .4em 0; }
      .pdf-page-start { break-before: ${settings.chapterStart === 'right' ? 'right' : 'page'}; page-break-before: ${settings.chapterStart === 'right' ? 'right' : 'always'}; }
      @media screen { body { zoom: ${scale}; } }
      @media print { body { padding: 0; zoom: 1; } main { width: auto; margin: 0; } a { color: inherit; text-decoration: none; } }
    `;
    doc.getElementById('pdf-title-page').hidden = !settings.titlePage;
    doc.querySelectorAll('.pdf-page-start').forEach(element => element.classList.remove('pdf-page-start'));
    for (const id of settings.starts) {
      const element = doc.getElementById(id);
      if (element) element.classList.add('pdf-page-start');
    }
    // An explicit title page replaces the existing inline book-cover figure.
    doc.querySelectorAll('#pdf-content .book-cover').forEach(element => { element.hidden = settings.titlePage; });
    try { localStorage.setItem('reader-pdf-settings', JSON.stringify({ ...settings, starts: undefined })); } catch (_) {}
    save.disabled = true;
    const version = ++revision;
    doc.fonts.ready.then(() => {
      if (version !== revision || !dialog.open) return;
      save.disabled = false;
      status.textContent = 'اختر «حفظ بصيغة PDF» في نافذة الطباعة.';
    });
  }
  function buildPreview() {
    const doc = document.implementation.createHTMLDocument(book.title);
    doc.documentElement.lang = book.language;
    doc.documentElement.dir = book.direction;
    for (const href of ['fonts.css', 'book-original.css']) {
      const link = doc.createElement('link'); link.rel = 'stylesheet'; link.href = new URL(href, location.href).href; doc.head.append(link);
    }
    const webFonts = document.querySelector('link[href*="fonts.googleapis.com/css"]');
    if (webFonts) { const link = doc.createElement('link'); link.rel = 'stylesheet'; link.href = webFonts.href; doc.head.append(link); }
    const layout = doc.createElement('style'); layout.id = 'pdf-layout'; doc.head.append(layout);
    const main = doc.createElement('main');
    const titlePage = doc.createElement('section'); titlePage.id = 'pdf-title-page'; titlePage.className = 'pdf-title-page';
    const cover = book.assets[book.cover] || book.cover;
    if (cover) { const image = doc.createElement('img'); image.src = cover; image.alt = `غلاف ${book.title}`; titlePage.append(image); }
    const title = doc.createElement('h1'); title.textContent = book.title;
    const author = doc.createElement('p'); author.textContent = book.author;
    titlePage.append(title, author);
    const content = doc.createElement('article'); content.id = 'pdf-content'; content.innerHTML = book.contentHtml;
    content.querySelectorAll('img').forEach(image => {
      image.src = book.assets[image.getAttribute('src')] || image.getAttribute('src');
      image.loading = 'eager';
    });
    main.append(titlePage, content); doc.body.append(main);
    previewReady = false;
    save.disabled = true;
    const version = ++revision;
    frame.onload = async () => {
      if (version !== revision || !dialog.open) return;
      previewReady = true;
      await Promise.all([...frame.contentDocument.images].map(image => image.decode().catch(() => {})));
      if (version !== revision || !dialog.open) return;
      applyPreferences();
    };
    frame.srcdoc = '<!doctype html>' + doc.documentElement.outerHTML;
  }
  async function open(selectedBook) {
    book = selectedBook;
    form.reset();
    try {
      const saved = JSON.parse(localStorage.getItem('reader-pdf-settings') || 'null');
      for (const [name, value] of Object.entries(saved || {})) {
        const input = form.elements.namedItem(name);
        if (input) { if (input.type === 'checkbox') input.checked = value; else input.value = value; }
      }
    } catch (_) {}
    breaks.replaceChildren();
    for (const chapter of book.toc) {
      const label = document.createElement('label'); label.className = 'pdf-checkbox';
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = chapter.id;
      input.checked = form.elements.chapterStart.value !== 'continuous';
      const text = document.createElement('span'); text.textContent = chapter.title;
      label.append(input, text); breaks.append(label);
    }
    document.getElementById('pdf-book-title').textContent = book.title;
    status.textContent = 'جارٍ تجهيز الكتاب والخطوط…';
    dialog.showModal();
    buildPreview();
  }
  form.addEventListener('submit', event => event.preventDefault());
  form.addEventListener('input', event => {
    if (event.target.name === 'chapterStart') {
      breaks.querySelectorAll('input').forEach(input => { input.checked = event.target.value !== 'continuous'; });
    }
    applyPreferences();
  });
  save.addEventListener('click', () => {
    if (!previewReady) return;
    frame.contentWindow.focus();
    frame.contentWindow.print();
  });
  dialog.addEventListener('close', () => { revision++; previewReady = false; frame.srcdoc = ''; });
  new ResizeObserver(() => { if (dialog.open && previewReady) applyPreferences(); }).observe(frame);
  window.BookPDF = { open };
})();
