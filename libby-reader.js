/**
 * Libby E-Reader Engine for "الشركة الناشئة المرنة — إريك ريس"
 * Pure Horizontal Paginated Reader (التقليب الأفقي التام - بدون أي تمرير عمودي)
 * Implements the authentic Libby reading experience:
 * - Clean Modern Flat Cover Presentation (Zero 3D Distortion)
 * - Multi-Column Horizontal Sliding Pages (GPU Transform - Pixel Perfect)
 * - Exact Libby HUD (ص. X من Total, Chapter Name, %, remaining pages)
 * - Interactive Footnote & Citation Viewer Card (Full clickability & popup)
 * - Saved page marker with a logical content anchor across viewport changes
 * - Scrubbing Timeline with 28 chapter markers
 * - Appearance Modal (A): Text Scale, Light/Sepia/Dark, Font Selection, Spread/Single
 * - TOC Drawer with instant horizontal page jump
 * - Full Text Search & Bookmarks
 * - Responsive Touch Gestures (Swipes, Edge Taps, HUD toggle)
 */

(function () {
  'use strict';

  let CHAPTER_METAS = [];
  let readerReady;
  const ready = new Promise(resolve => { readerReady = resolve; });

  // Global State
  const state = {
    currentPage: 1,
    readingLocation: null,
    layoutBusy: false,
    totalPages: 1,
    isHudVisible: false,
    theme: 'warm',
    font: 'book',
    fontSize: 18,
    layoutMode: 'single', // 'single' | 'spread'
    bookmarks: {},
    pauseMarker: null, // { page, elementId, snippet, time, timestamp }
    currentChapterTitle: 'غلاف الكتاب',
    chapterPages: []
  };

  // SVGs for dynamic injection
  const SVG_BOOK = `<svg class="libby-svg-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>`;
  const SVG_CHEVRON_LEFT = `<svg class="libby-svg-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>`;


  const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  function readingKey(name) { return 'reader-book-' + window.BookLibrary.activeBook.id + '-' + name; }

  function saveState(syncProgress = false) {
    try {
      localStorage.setItem(readingKey('page'), state.currentPage);
      if (state.readingLocation) localStorage.setItem(readingKey('location'), JSON.stringify(state.readingLocation));
      localStorage.setItem('libby-lean-theme', state.theme);
      localStorage.setItem('libby-lean-font', state.font);
      localStorage.setItem('reader-font-size-v2', state.fontSize);
      localStorage.setItem('libby-lean-layout', state.layoutMode);
      localStorage.setItem(readingKey('bookmarks'), JSON.stringify(state.bookmarks));
      if (state.pauseMarker) {
        localStorage.setItem(readingKey('pause'), JSON.stringify(state.pauseMarker));
      } else {
        localStorage.removeItem(readingKey('pause'));
      }
    } catch (e) {
      console.warn('Storage unavailable', e);
    }
    if (syncProgress) window.dispatchEvent(new CustomEvent('reader-progress-changed', { detail: {
      page: state.currentPage, location: state.readingLocation, pause: state.pauseMarker ? {
        page: state.pauseMarker.page, location: state.pauseMarker.location || null,
        snippet: (state.pauseMarker.snippet || '').slice(0, 1000), timestamp: state.pauseMarker.timestamp || Date.now()
      } : null
    } }));
  }

  function loadState() {
    try {
      state.readingLocation = JSON.parse(localStorage.getItem(readingKey('location')) || 'null');
      state.currentPage = parseInt(localStorage.getItem(readingKey('page')) || '1', 10);
      state.theme = localStorage.getItem('libby-lean-theme') || 'warm';
      state.font = localStorage.getItem('libby-lean-font') || 'book';
      const preferred = Number(localStorage.getItem('reader-font-size-v2'));
      state.fontSize = preferred >= 14 && preferred <= 28 ? preferred : (matchMedia('(pointer: coarse)').matches ? 21 : 18);
      state.layoutMode = localStorage.getItem('libby-lean-layout') || 'single';
      const bmarks = localStorage.getItem(readingKey('bookmarks'));
      if (bmarks) state.bookmarks = JSON.parse(bmarks);
      const pause = localStorage.getItem(readingKey('pause'));
      if (pause) state.pauseMarker = JSON.parse(pause);
    } catch (e) {
      console.warn('Storage unavailable', e);
    }
  }

  // DOM Elements
  const viewCover = document.getElementById('view-cover');
  const viewReader = document.getElementById('view-reader');
  const hudTop = document.getElementById('reader-hud-top');
  const hudBottom = document.getElementById('reader-hud-bottom');
  const columnWindow = document.getElementById('reader-column-window');
  const columnsContent = document.getElementById('reader-columns-content');
  const bookArticle = document.getElementById('book-article');

  const layout = { width: 0, height: 0, gap: 60 };
  const blocks = () => [...bookArticle.querySelectorAll('p,h1,h2,h3,h4,li,figure,table')];
  function locationRange(location) {
    if (!location || !Number.isInteger(location.block) || location.block < 0) return null;
    const block = blocks()[location.block];
    if (!block) return null;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let remaining = Math.max(0, Number(location.offset) || 0), node;
    while ((node = walker.nextNode())) {
      if (remaining < node.length || (remaining === 0 && node.length)) {
        const range = document.createRange(); range.setStart(node, remaining); range.setEnd(node, Math.min(node.length, remaining + 1)); return range;
      }
      remaining -= node.length;
    }
    return block;
  }
  function pageAtLocation(location) {
    const range = locationRange(location);
    if (!range || !layout.width) return state.currentPage;
    const rect = range.getClientRects()[0] || range.getBoundingClientRect();
    const articleRect = bookArticle.getBoundingClientRect();
    const distance = bookArticle.dir === 'ltr' ? rect.left - articleRect.left : articleRect.right - rect.right;
    return Math.max(1, Math.min(state.totalPages, Math.floor((Math.max(0, distance) + 0.5) / (layout.width + layout.gap)) + 1));
  }
  function captureLocation() {
    if (!layout.width || !viewReader.classList.contains('active')) return state.readingLocation;
    const viewport = columnWindow.getBoundingClientRect(), list = blocks();
    // Ignore page-turn overlays while locating the first visible line of text.
    const overlays = [...document.querySelectorAll('.tap-zone')];
    const values = overlays.map(element => element.style.pointerEvents);
    overlays.forEach(element => { element.style.pointerEvents = 'none'; });
    try {
      for (const block of list) {
        const textRange = document.createRange(); textRange.selectNodeContents(block);
        const rects = block.matches('figure,table') ? [...block.getClientRects()] : [...textRange.getClientRects()];
        const visible = rects.find(rect => rect.right > viewport.left + 4 && rect.left < viewport.right - 4 && rect.bottom > viewport.top + 4 && rect.top < viewport.bottom);
        if (!visible) continue;
        const y = Math.max(viewport.top + 2, visible.top + Math.min(visible.height / 2, 10));
        const x = Math.max(viewport.left + 4, Math.min(viewport.right - 4, (visible.left + visible.right) / 2));
        let node, offset;
        const caret = document.caretPositionFromPoint?.(x, y);
        if (caret) { node = caret.offsetNode; offset = caret.offset; }
        else { const range = document.caretRangeFromPoint?.(x, y); if (range) { node = range.startContainer; offset = range.startOffset; } }
        if (node && block.contains(node)) {
          const prefix = document.createRange(); prefix.selectNodeContents(block); prefix.setEnd(node, offset);
          return { block: list.indexOf(block), offset: prefix.toString().length };
        }
        // Covers and diagrams may not contain text.
        if (block.matches('figure,table')) return { block: list.indexOf(block), offset: 0 };
      }
    } finally { overlays.forEach((element, index) => { element.style.pointerEvents = values[index]; }); }
    return state.readingLocation;
  }
  let reflowTimer, reflowFrame, reflowRevision = 0;
  function scheduleReflow() {
    if (!viewReader.classList.contains('active')) return;
    state.layoutBusy = true;
    const revision = ++reflowRevision;
    document.documentElement.style.setProperty('--reader-viewport-height', `${window.visualViewport?.height || window.innerHeight}px`);
    clearTimeout(reflowTimer); cancelAnimationFrame(reflowFrame);
    reflowTimer = setTimeout(() => {
      reflowFrame = requestAnimationFrame(() => requestAnimationFrame(() => {
        if (revision !== reflowRevision) return;
        try { recalculatePagination(true); } finally { state.layoutBusy = false; }
      }));
    }, 160);
  }

  // --- Views Controller ---
  function openReader(targetPage) {
    const resumeLocation = targetPage ? null : state.readingLocation;
    document.documentElement.style.setProperty('--reader-viewport-height', `${window.visualViewport?.height || window.innerHeight}px`);
    if (viewCover) viewCover.classList.add('hidden');
    if (viewReader) viewReader.classList.add('active');

    // Recalculate horizontal pagination
    setTimeout(() => {
      recalculatePagination(false);
      const p = targetPage || state.currentPage || 1;
      goToPage(targetPage ? p : (resumeLocation ? pageAtLocation(resumeLocation) : p), false);
    }, 60);
  }

  function openCover() {
    if (viewReader) viewReader.classList.remove('active');
    if (viewCover) viewCover.classList.remove('hidden');
    updateCoverButton();
  }

  function updateCoverButton() {
    const btn = document.getElementById('btn-start-reading');
    const textSpan = document.getElementById('btn-start-reading-text');
    if (btn && textSpan) {
      textSpan.textContent = 'متابعة القراءة';
    }
    updatePauseMarkerUI();
  }

  // --- Horizontal Multi-Column Pagination Engine ---
  function recalculatePagination(preserveLocation = true) {
    if (!columnWindow || !bookArticle) return;

    const windowWidth = columnWindow.getBoundingClientRect().width;
    const windowHeight = columnWindow.getBoundingClientRect().height;
    const savedLocation = preserveLocation ? state.readingLocation : null;
    if (windowWidth <= 0 || windowHeight <= 0) return;

    const gap = 60;
    const isSpread = false;
    layout.width = windowWidth; layout.height = windowHeight;
    columnsContent.style.transition = 'none';
    columnsContent.style.transform = 'none';
    columnWindow.scrollLeft = 0; columnWindow.scrollTop = 0;
    bookArticle.style.columnCount = '1';

    // Constrain bookArticle dimensions strictly to match window (no vertical overflow)
    bookArticle.style.width = windowWidth + 'px';
    bookArticle.style.height = windowHeight + 'px';
    bookArticle.style.maxHeight = windowHeight + 'px';

    const colW = isSpread ? Math.floor((windowWidth - gap) / 2) : windowWidth;
    bookArticle.style.columnWidth = colW + 'px';
    bookArticle.style.columnGap = gap + 'px';

    // Strictly contain cover image and illustrations within a single column
    const coverFig = document.querySelector('#book-article .book-cover');
    if (coverFig) {
      coverFig.style.setProperty('box-sizing', 'border-box', 'important');
      coverFig.style.setProperty('height', (windowHeight - 20) + 'px', 'important');
      coverFig.style.setProperty('max-height', (windowHeight - 20) + 'px', 'important');
      coverFig.style.setProperty('width', windowWidth + 'px', 'important');
      coverFig.style.setProperty('max-width', '100%', 'important');
      coverFig.style.setProperty('break-inside', 'avoid', 'important');
      coverFig.style.setProperty('display', 'flex', 'important');
      coverFig.style.setProperty('align-items', 'center', 'important');
      coverFig.style.setProperty('justify-content', 'center', 'important');
      coverFig.style.setProperty('margin', '0 auto', 'important');

      const cImg = coverFig.querySelector('img');
      if (cImg) {
        cImg.style.setProperty('max-height', (windowHeight - 40) + 'px', 'important');
        cImg.style.setProperty('max-width', '100%', 'important');
        cImg.style.setProperty('width', 'auto', 'important');
        cImg.style.setProperty('height', 'auto', 'important');
        cImg.style.setProperty('object-fit', 'contain', 'important');
      }
    }

    const stride = windowWidth + gap;
    const total = Math.max(1, Math.round((bookArticle.scrollWidth + gap) / stride));
    state.totalPages = total;

    // Index chapter positions in horizontal pages
    indexChapterPagePositions(stride);
    updateChapterMarkers();

    if (savedLocation) state.currentPage = pageAtLocation(savedLocation);
    if (state.pauseMarker?.location) state.pauseMarker.page = pageAtLocation(state.pauseMarker.location);
    // Clamp current page
    state.currentPage = Math.max(1, Math.min(state.totalPages, state.currentPage));

    applyPageTransform(false);
    updateHudStats();
    state.readingLocation = captureLocation();
    updatePauseMarkerUI();
    saveState();
  }

  function indexChapterPagePositions(stride) {
    state.chapterPages = [];
    if (!bookArticle) return;
    const artRect = bookArticle.getBoundingClientRect();

    CHAPTER_METAS.forEach((ch, idx) => {
      const el = document.getElementById(ch.id);
      if (el) {
        const elRect = el.getBoundingClientRect();
        // In Arabic RTL, offset from right edge of article
        const diffFromRight = Math.max(0, bookArticle.dir === 'ltr' ? elRect.left - artRect.left : artRect.right - elRect.right);
        const page = Math.floor(diffFromRight / stride) + 1;
        state.chapterPages.push({
          id: ch.id,
          title: ch.title,
          page: Math.min(state.totalPages, page)
        });
      } else {
        state.chapterPages.push({
          id: ch.id,
          title: ch.title,
          page: Math.round((idx / CHAPTER_METAS.length) * state.totalPages) + 1
        });
      }
    });

    // Sort by page
    state.chapterPages.sort((a, b) => a.page - b.page);
  }

  function getActiveChapterInfo(pageNum) {
    if (!state.chapterPages || state.chapterPages.length === 0) {
      return { title: window.BookLibrary.activeBook.title, remaining: Math.max(0, state.totalPages - pageNum) };
    }

    let cur = state.chapterPages[0];
    let next = null;

    for (let i = 0; i < state.chapterPages.length; i++) {
      if (pageNum >= state.chapterPages[i].page) {
        cur = state.chapterPages[i];
        next = state.chapterPages[i + 1] || null;
      } else {
        break;
      }
    }

    const endPage = next ? (next.page - 1) : state.totalPages;
    const remaining = Math.max(0, endPage - pageNum);

    return {
      title: cur.title,
      remaining: remaining,
      startPage: cur.page,
      endPage
    };
  }

  // --- Horizontal Page Navigation (GPU Transform translateX - 100% Precision) ---
  function applyPageTransform(animate = true) {
    if (!columnsContent || !columnWindow) return;

    const windowWidth = layout.width || columnWindow.getBoundingClientRect().width;
    const gap = 60;
    const stride = windowWidth + gap;
    const pageIndex = state.currentPage - 1;

    // In Arabic RTL: Column 1 is at 0. Advancing to Column 2 (flowing to the left) shifts content to the RIGHT (+stride * pageIndex)
    const targetX = pageIndex * stride * (bookArticle.dir === 'ltr' ? -1 : 1);

    if (animate) {
      columnsContent.style.transition = 'transform 0.32s cubic-bezier(0.16, 1, 0.3, 1)';
    } else {
      columnsContent.style.transition = 'none';
    }

    columnsContent.style.transform = `translateX(${targetX}px)`;

    // Keep columnWindow scrollLeft at 0 always to eliminate browser-specific RTL scroll bugs
    columnWindow.scrollLeft = 0;
  }

  function goToPage(pageNum, animate = true) {
    const clamped = Math.max(1, Math.min(state.totalPages, pageNum));
    const changed = clamped !== state.currentPage;
    state.currentPage = clamped;

    applyPageTransform(false);
    state.readingLocation = captureLocation();
    updateHudStats();
    saveState(true);
    if (changed) flashChapterProgress();
  }

  let chapterFlash;
  function flashChapterProgress() {
    const panel = document.getElementById('chapter-progress');
    const chapter = getActiveChapterInfo(state.currentPage);
    const start = chapter.startPage || 1, end = chapter.endPage || state.totalPages;
    const percent = Math.round(100 * (state.currentPage - start + 1) / Math.max(1, end - start + 1));
    document.getElementById('chapter-progress-title').textContent = chapter.title;
    document.getElementById('chapter-progress-value').value = percent;
    document.getElementById('chapter-progress-label').textContent = `${percent}٪`;
    chapterFlash?.cancel();
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    chapterFlash = panel.animate(reduced ? [{ opacity: 1 }, { opacity: 1 }] : [
      { opacity: 0, offset: 0 }, { opacity: 1, offset: .25 },
      { opacity: 1, offset: .75 }, { opacity: 0, offset: 1 }
    ], { duration: 1000, easing: 'linear' });
  }

  function nextPage() {
    if (state.layoutBusy) return;
    if (state.currentPage < state.totalPages) {
      goToPage(state.currentPage + 1, true);
    } else {
      showToast('وصلت إلى نهاية الكتاب');
    }
  }

  function prevPage() {
    if (state.layoutBusy) return;
    if (state.currentPage > 1) {
      goToPage(state.currentPage - 1, true);
    }
  }

  // --- Update HUD Stats ---
  function updateHudStats() {
    const pageNum = state.currentPage;
    const chInfo = getActiveChapterInfo(pageNum);
    state.currentChapterTitle = chInfo.title;

    const pageCountEl = document.getElementById('stat-page-count');
    const chNameEl = document.getElementById('stat-chapter-name');
    const pctEl = document.getElementById('stat-percentage');
    const chRemainEl = document.getElementById('stat-chapter-remaining');
    const hudTopChEl = document.getElementById('hud-chapter-name');
    const progressFill = document.getElementById('libby-progress-fill');
    const ribbon = document.getElementById('bookmark-corner-ribbon');
    const bmarkBtn = document.getElementById('btn-hud-bookmark');

    // Right: ص. X من Total
    if (pageCountEl) pageCountEl.textContent = `ص. ${pageNum} من ${state.totalPages}`;
    if (chNameEl) chNameEl.textContent = chInfo.title;
    if (hudTopChEl) hudTopChEl.textContent = chInfo.title;

    // Left: Percentage and Remaining pages in chapter
    const pct = Math.max(1, Math.round((pageNum / state.totalPages) * 100));
    if (pctEl) pctEl.textContent = `${pct}%`;
    if (chRemainEl) {
      chRemainEl.innerHTML = `<span>${chInfo.remaining} ص <span class="remaining-arrow">${SVG_CHEVRON_LEFT}</span></span>`;
    }

    // Progress bar fill width
    if (progressFill) {
      const fillPct = ((pageNum - 1) / Math.max(1, state.totalPages - 1)) * 100;
      progressFill.style.width = `${Math.max(1, fillPct)}%`;
    }

    // Bookmark indicator
    const isBookmarked = state.pauseMarker?.page === pageNum;
    if (ribbon) ribbon.classList.toggle('is-active', isBookmarked);
    if (bmarkBtn) bmarkBtn.classList.toggle('is-active', isBookmarked);
    updatePauseMarkerUI();

    updateCoverButton();
  }

  // --- HUD Visibility Toggle ---
  function toggleHud(forceState) {
    if (typeof forceState === 'boolean') {
      state.isHudVisible = forceState;
    } else {
      state.isHudVisible = !state.isHudVisible;
    }

    const toggle = document.getElementById('reader-tools-toggle');
    toggle.classList.toggle('is-revealed', state.isHudVisible);
    if (state.isHudVisible) toggle.focus({ preventScroll: true });
  }

  // --- Dynamic Chapter Markers along Timeline ---
  function updateChapterMarkers() {
    const markersBox = document.getElementById('track-chapter-markers');
    if (!markersBox) return;
    markersBox.innerHTML = '';

    if (!state.chapterPages || state.chapterPages.length === 0) {
      CHAPTER_METAS.forEach((ch, idx) => {
        const pct = (idx / CHAPTER_METAS.length) * 100;
        const tick = document.createElement('div');
        tick.className = 'track-marker-tick';
        tick.style.right = `${pct}%`;
        tick.title = ch.title;
        markersBox.appendChild(tick);
      });
      return;
    }

    state.chapterPages.forEach(ch => {
      const pct = Math.max(0, Math.min(100, ((ch.page - 1) / Math.max(1, state.totalPages - 1)) * 100));
      const tick = document.createElement('div');
      tick.className = 'track-marker-tick';
      tick.style.right = `${pct}%`;
      tick.title = `${ch.title} (ص. ${ch.page})`;
      tick.onclick = (e) => {
        e.stopPropagation();
        goToPage(ch.page, true);
      };
      markersBox.appendChild(tick);
    });
  }

  // --- Scrubber Timeline Generation ---
  function initTimelineScrubber() {
    const track = document.getElementById('libby-progress-track');
    if (!track) return;

    updateChapterMarkers();

    // Scrubbing on click/drag
    let isDragging = false;
    const handleScrub = (e) => {
      const rect = track.getBoundingClientRect();
      const clientX = e.clientX || (e.touches && e.touches[0].clientX);
      if (clientX === undefined) return;

      // In RTL, right is 0%, left is 100%
      const posFromRight = rect.right - clientX;
      const pct = Math.max(0, Math.min(1, posFromRight / rect.width));
      const targetPage = Math.max(1, Math.min(state.totalPages, Math.round(pct * state.totalPages)));

      goToPage(targetPage, false);
    };

    track.addEventListener('mousedown', (e) => {
      isDragging = true;
      handleScrub(e);
    });

    window.addEventListener('mousemove', (e) => {
      if (isDragging) handleScrub(e);
    });

    window.addEventListener('mouseup', () => {
      isDragging = false;
    });

    track.addEventListener('touchstart', (e) => {
      handleScrub(e);
    }, { passive: true });

    track.addEventListener('touchmove', (e) => {
      handleScrub(e);
    }, { passive: true });
  }

  // --- Appearance Settings Controls ---
  function applyTheme(theme) {
    state.theme = theme;
    document.body.setAttribute('data-theme', theme);
    document.querySelectorAll('.theme-pill-btn').forEach(btn => {
      btn.classList.toggle('is-selected', btn.dataset.themeVal === theme);
    });
    saveState();
  }

  function applyFont(font) {
    state.font = font;
    document.body.setAttribute('data-reader-font', font);
    document.querySelectorAll('.font-choice-btn').forEach(btn => {
      btn.classList.toggle('is-selected', btn.dataset.fontVal === font);
    });
    saveState();
    scheduleReflow();
  }

  function applyFontSize(size) {
    size = Math.max(14, Math.min(28, Number(size) || 18));
    state.fontSize = size;
    document.documentElement.style.setProperty('--reader-font-size', `${size}px`);
    const display = document.getElementById('font-size-val-display');
    if (display) display.textContent = `${size}px`;
    const range = document.getElementById('font-size-range');
    if (range && parseInt(range.value, 10) !== size) range.value = size;
    saveState();
    scheduleReflow();
  }

  function applyLayout(mode) {
    mode = 'single';
    state.layoutMode = mode;
    document.body.classList.toggle('mode-spread', mode === 'spread');
    document.querySelectorAll('.layout-choice-btn').forEach(btn => {
      btn.classList.toggle('is-selected', btn.dataset.layoutVal === mode);
    });
    saveState();
    scheduleReflow();
  }

  // --- Modals Controller ---
  function openModal(id) {
    closeModals();
    const modal = document.getElementById(id);
    if (modal) modal.classList.add('is-open');
  }

  function closeModals() {
    document.querySelectorAll('.modal-backdrop').forEach(m => m.classList.remove('is-open'));
  }

  // --- Table of Contents Drawer ---
  function renderToc() {
    const list = document.getElementById('toc-list-items');
    if (!list) return;
    list.innerHTML = '';

    CHAPTER_METAS.forEach((ch, idx) => {
      const li = document.createElement('li');
      const chInfo = state.chapterPages.find(c => c.id === ch.id);
      const page = chInfo ? chInfo.page : 1;
      const isCur = state.currentChapterTitle === ch.title;

      li.className = `toc-item-link ${isCur ? 'current-chapter' : ''}`;
      const title = document.createElement('span'); title.textContent = ch.title;
      const number = document.createElement('span'); number.className = 'toc-page-num'; number.textContent = `ص. ${page}`;
      li.append(title, number);
      li.onclick = () => {
        closeModals();
        openReader(page);
      };
      list.appendChild(li);
    });
  }

  // --- Search Engine ---
  function searchBook(query) {
    const container = document.getElementById('search-results-list');
    if (!container) return;

    if (!query || query.trim().length < 2) {
      container.innerHTML = `<p style="text-align:center;color:var(--text-muted);padding:1.5rem;">اكتب كلمتين أو أكثر للبحث في صفحات الكتاب...</p>`;
      return;
    }

    const article = document.getElementById('book-article');
    if (!article) return;

    const paragraphs = article.querySelectorAll('p, h2, td');
    const qLower = query.toLowerCase().trim();
    const results = [];
    const stride = (columnWindow ? Math.floor(columnWindow.clientWidth) : 760) + 60;

    const artRect = article.getBoundingClientRect();
    paragraphs.forEach(p => {
      const text = p.textContent;
      if (text.toLowerCase().includes(qLower)) {
        const pRect = p.getBoundingClientRect();
        const diffFromRight = Math.max(0, bookArticle.dir === 'ltr' ? pRect.left - artRect.left : artRect.right - pRect.right);
        const page = Math.floor(diffFromRight / stride) + 1;

        results.push({
          page: Math.max(1, Math.min(state.totalPages, page)),
          text: text
        });
      }
    });

    if (results.length === 0) {
      container.innerHTML = `<p style="text-align:center;color:var(--text-muted);padding:1.5rem;">لم يتم العثور على نتائج مطابقة لـ "${escapeHtml(query)}"</p>`;
      return;
    }

    container.innerHTML = `<p style="font-size:0.85rem;color:var(--libby-teal);font-weight:700;margin-bottom:0.5rem;">تم العثور على ${results.length} نتيجة مطابقة:</p>`;

    results.slice(0, 30).forEach(r => {
      const item = document.createElement('div');
      item.className = 'search-result-item';

      const highlighted = r.text.length > 200 ? r.text.slice(0, 200) + '…' : r.text;
      const heading = document.createElement('div'); heading.textContent = `صفحة ${r.page}`;
      const snippet = document.createElement('div'); snippet.className = 'search-snippet';
      let offset = 0, found;
      while ((found = highlighted.toLowerCase().indexOf(qLower, offset)) !== -1) {
        snippet.append(document.createTextNode(highlighted.slice(offset, found)));
        const mark = document.createElement('mark'); mark.textContent = highlighted.slice(found, found + qLower.length); snippet.append(mark);
        offset = found + qLower.length;
      }
      snippet.append(document.createTextNode(highlighted.slice(offset)));
      item.append(heading, snippet);
      item.onclick = () => {
        closeModals();
        goToPage(r.page, true);
        showToast(`انتقلت إلى صفحة ${r.page}`);
      };
      container.appendChild(item);
    });
  }

  // --- Bookmarks Manager ---
  function toggleBookmark() {
    if (state.pauseMarker?.page === state.currentPage) clearPauseMarker();
    else setPauseMarker();
  }

  function renderBookmarks() {
    const list = document.getElementById('bookmarks-list-items');
    if (!list) return;
    list.innerHTML = '';

    const keys = Object.keys(state.bookmarks).map(k => parseInt(k, 10)).sort((a, b) => a - b);
    if (keys.length === 0) {
      list.innerHTML = `<li style="text-align:center;color:var(--text-muted);padding:1.5rem;">لا توجد إشارات مرجعية محفوظة بعد.</li>`;
      return;
    }

    keys.forEach(k => {
      const b = state.bookmarks[k];
      const li = document.createElement('li');
      li.className = 'toc-item-link';
      li.innerHTML = `
        <div>
          <span style="font-weight:700;">صفحة ${b.page}</span>
          <span style="font-size:0.8rem;color:var(--text-muted);margin-inline-start:0.5rem;">${escapeHtml(b.chapter)}</span>
        </div>
        <span style="font-size:0.75rem;color:var(--text-muted);">${escapeHtml(b.time)}</span>
      `;
      li.onclick = () => {
        closeModals();
        goToPage(b.page, true);
      };
      list.appendChild(li);
    });
  }

  // --- Interactive Footnotes Viewer ---
  function openFootnoteModal(href, noteNum, noteSec) {
    if (!href) return;
    const cleanId = href.startsWith('#') ? href.slice(1) : href;
    const targetEl = document.getElementById(cleanId);
    const modal = document.getElementById('modal-footnote');
    const badgeEl = document.getElementById('footnote-sheet-badge');
    const titleEl = document.getElementById('footnote-sheet-title');
    const contentEl = document.getElementById('footnote-modal-content');
    const jumpBtn = document.getElementById('btn-jump-to-endnote');

    if (!modal || !contentEl) return;

    if (badgeEl) badgeEl.textContent = `حاشية ${noteNum || ''}`;
    if (titleEl) {
      const secName = noteSec === 'intro' ? 'المقدمة' : (noteSec ? `الفصل ${noteSec}` : 'المراجع والحواشي');
      titleEl.textContent = `مرجع ${secName}`;
    }

    if (targetEl) {
      // Clone text, ensuring links work
      contentEl.innerHTML = targetEl.innerHTML;
      // Make all links open in new tab safely
      contentEl.querySelectorAll('a').forEach(a => {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener');
      });
    } else {
      contentEl.innerHTML = `<p>حاشية مرجعية رقم ${escapeHtml(noteNum)}.</p>`;
    }

    if (jumpBtn) {
      jumpBtn.onclick = () => {
        closeModals();
        if (targetEl) {
          const rect = targetEl.getBoundingClientRect();
          const articleRect = bookArticle.getBoundingClientRect();
          const distance = bookArticle.dir === 'ltr' ? rect.left - articleRect.left : articleRect.right - rect.right;
          const targetPage = Math.floor(Math.max(0, distance) / (columnWindow.clientWidth + 60)) + 1;
          goToPage(targetPage, true);
          showToast('انتقلت إلى قسم الحواشي والمراجع في نهاية الكتاب');
        }
      };
    }

    openModal('modal-footnote');
  }

  // A saved page is a logical reading location, independent of viewport dimensions.
  function setPauseMarker() {
    state.pauseMarker = { page: state.currentPage, location: captureLocation(), snippet: state.currentChapterTitle, timestamp: Date.now() };
    saveState(true); updatePauseMarkerUI(); showToast('تم حفظ هذه الصفحة');
  }
  function resumeFromPauseMarker() {
    if (!state.pauseMarker) return;
    const marker = state.pauseMarker;
    openReader(marker.page);
    setTimeout(() => {
      goToPage(marker.location ? pageAtLocation(marker.location) : marker.page, false);
    }, 90);
  }
  function clearPauseMarker() {
    state.pauseMarker = null;
    saveState(true); updatePauseMarkerUI(); showToast('تمت إزالة علامة الصفحة');
  }
  function updatePauseMarkerUI() {
    const marker = state.pauseMarker;
    const marked = !!marker && marker.page === state.currentPage;
    const button = document.getElementById('btn-hud-bookmark');
    if (button) {
      const icon = button.querySelector('svg');
      if (icon && window.ReaderIcons) icon.outerHTML = marked ? window.ReaderIcons['bookmark-check'] : window.ReaderIcons.bookmark;
      button.classList.toggle('is-active', marked); button.setAttribute('aria-pressed', String(marked));
      button.title = marked ? 'إزالة علامة هذه الصفحة' : 'حفظ هذه الصفحة';
      button.setAttribute('aria-label', button.title);
      const label = button.querySelector('.control-label'); if (label) label.textContent = marked ? 'إزالة العلامة' : 'حفظ الصفحة';
    }
    document.getElementById('saved-page-actions').hidden = !marker;
    document.getElementById('saved-page-label').textContent = marker ? `الصفحة المحفوظة: ${marker.page}` : '';
    document.getElementById('saved-page-indicator').hidden = !marked;
  }

  // --- Toast Notification ---
  function showToast(msg) {
    const toast = document.getElementById('libby-toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('is-shown');
    setTimeout(() => {
      toast.classList.remove('is-shown');
    }, 2200);
  }

  // --- Global Event Listeners ---
  function initEvents() {
    // Cover Actions
    const startReadingBtn = document.getElementById('btn-start-reading');
    if (startReadingBtn) {
      startReadingBtn.addEventListener('click', () => openReader());
    }

    // Reader Top HUD Actions
    const backBtn = document.getElementById('reader-back-btn');
    if (backBtn) {
      backBtn.addEventListener('click', openCover);
    }

const btnAppearance = document.getElementById('btn-hud-appearance');
    if (btnAppearance) {
      btnAppearance.addEventListener('click', () => openModal('modal-appearance'));
    }

    const btnToc = document.getElementById('btn-hud-toc');
    if (btnToc) {
      btnToc.addEventListener('click', () => {
        renderToc();
        openModal('modal-toc');
      });
    }

    const btnSearch = document.getElementById('btn-hud-search');
    if (btnSearch) {
      btnSearch.addEventListener('click', () => openModal('modal-search'));
    }

    const btnBookmark = document.getElementById('btn-hud-bookmark');
    if (btnBookmark) {
      btnBookmark.addEventListener('click', toggleBookmark);
    }

    const ribbon = document.getElementById('bookmark-corner-ribbon');
    if (ribbon) {
      ribbon.addEventListener('click', toggleBookmark);
    }

    // Footnotes & Paragraph Interaction Listener
    document.addEventListener('click', (e) => {
      // 1. Footnote Links Interception
      const footLink = e.target.closest('.footnote-link');
      if (footLink) {
        e.preventDefault();
        e.stopPropagation();
        const href = footLink.getAttribute('href');
        const num = footLink.getAttribute('data-footnote-number') || footLink.textContent.trim();
        const sec = footLink.getAttribute('data-note-section') || '';
        openFootnoteModal(href, num, sec);
        return;
      }

      const internalLink = e.target.closest('#book-article a[href^="#"]');
      if (internalLink) {
        const target = document.getElementById(internalLink.getAttribute('href').slice(1));
        if (target && bookArticle.contains(target)) {
          e.preventDefault();
          const artRect = bookArticle.getBoundingClientRect(), targetRect = target.getBoundingClientRect();
          const distance = bookArticle.dir === 'ltr' ? targetRect.left - artRect.left : artRect.right - targetRect.right;
          goToPage(Math.floor(Math.max(0, distance) / (columnWindow.clientWidth + 60)) + 1, true);
        }
        return;
      }

    });

    const toolsToggle = document.getElementById('reader-tools-toggle');
    const toolsPanel = document.getElementById('reader-tools-panel');
    toolsPanel.append(document.getElementById('reader-hud-top'), document.getElementById('reader-hud-bottom'));
    const closeTools = () => { toolsPanel.hidden = true; toolsToggle.setAttribute('aria-expanded', 'false'); toolsToggle.classList.remove('is-revealed'); };
    toolsToggle.addEventListener('click', () => {
      toolsToggle.classList.add('is-revealed');
      toolsPanel.hidden = !toolsPanel.hidden;
      toolsToggle.setAttribute('aria-expanded', String(!toolsPanel.hidden));
    });
    toolsPanel.addEventListener('click', e => { if (e.target.closest('button')) closeTools(); });
    document.getElementById('btn-saved-page-return').addEventListener('click', resumeFromPauseMarker);
    document.getElementById('btn-saved-page-remove').addEventListener('click', clearPauseMarker);
    document.getElementById('saved-page-indicator').addEventListener('click', clearPauseMarker);
    // TAP & CLICK ZONES (Horizontal Page Turn & HUD Toggle)
    const tapRight = document.getElementById('tap-zone-right');
    const tapLeft = document.getElementById('tap-zone-left');

    if (tapRight) {
      // In Arabic RTL: Tapping right goes back to PREVIOUS page
      tapRight.addEventListener('click', (e) => {
        e.stopPropagation();
        prevPage();
      });
    }

    if (tapLeft) {
      // In Arabic RTL: Tapping left advances to NEXT page
      tapLeft.addEventListener('click', (e) => {
        e.stopPropagation();
        nextPage();
      });
    }

    if (columnWindow) {
      columnWindow.addEventListener('click', (e) => {
        if (matchMedia('(pointer: coarse)').matches) return;
        // Ignore clicks on links, buttons, form inputs, footnote markers, or pause pins
        if (e.target.closest('a, button, input, select, textarea, .footnote-ref, .footnote-link')) return;
        const sel = window.getSelection();
        if (sel && sel.toString().trim().length > 0) return;

        const rect = columnWindow.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const w = rect.width;

        // In RTL: Rightmost 15% turns to PREVIOUS page
        if (clickX > w * 0.85) {
          prevPage();
        }
        // In RTL: Leftmost 15% turns to NEXT page
        else if (clickX < w * 0.15) {
          nextPage();
        }
        // Center turns HUD on/off
        else {
          toggleHud();
        }
      });
    }

    // Keyboard Navigation (Strictly Horizontal)
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
      if (!viewReader || !viewReader.classList.contains('active') || state.layoutBusy || !document.getElementById('book-library').hidden) return;

      if (e.key === 'ArrowLeft') {
        // RTL: Next page
        bookArticle.dir === 'ltr' ? prevPage() : nextPage();
      } else if (e.key === 'ArrowRight') {
        // RTL: Previous page
        bookArticle.dir === 'ltr' ? nextPage() : prevPage();
      } else if (e.key === ' ' || e.key === 'PageDown') {
        e.preventDefault();
        nextPage();
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        prevPage();
      } else if (e.key === 'Escape') {
        closeModals();
      }
    });

    // Touch Swipe & Drag Gestures (Horizontal)
    let touchStartX = 0;
    let touchStartY = 0;
    let touchStartTime = 0;
    let isHorizontalGesture = false;
    let readerTouchActive = false;

    window.addEventListener('touchstart', (e) => {
      isHorizontalGesture = false;
      readerTouchActive = false;
      if (!viewReader || !viewReader.classList.contains('active') || state.layoutBusy || !document.getElementById('book-library').hidden) return;
      if (e.target.closest('button, a, input, select, textarea, dialog, .modal-backdrop, .modal-sheet')) return;

      if(e.touches.length !== 1) {isHorizontalGesture=false;return;}
      readerTouchActive = true;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchStartTime = Date.now();
      isHorizontalGesture = false;
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      if(!readerTouchActive) return;
      if (!viewReader || !viewReader.classList.contains('active') || state.layoutBusy || !document.getElementById('book-library').hidden) return;
      if (e.target.closest('.modal-backdrop, #reader-tools-panel')) return;
      if(e.cancelable) e.preventDefault();
      if (e.touches.length !== 1) { isHorizontalGesture=false;return; }

      const diffX = e.touches[0].clientX - touchStartX;
      const diffY = e.touches[0].clientY - touchStartY;

      if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 10) {
        isHorizontalGesture = true;
      }
    }, { passive: false });

    window.addEventListener('touchend', (e) => {
      if(!readerTouchActive) return;
      readerTouchActive = false;
      if (!viewReader || !viewReader.classList.contains('active') || state.layoutBusy || !document.getElementById('book-library').hidden) return;
      if (!isHorizontalGesture) return;

      const diffX = e.changedTouches[0].clientX - touchStartX;
      const duration = Date.now() - touchStartTime;
      const velocity = Math.abs(diffX) / Math.max(1, duration);

      // In Arabic RTL:
      // Swipe left returns to the previous Arabic page.
      // Swipe right advances to the next Arabic page.
      if (diffX < -40 || (diffX < -20 && velocity > 0.3)) {
        bookArticle.dir === 'ltr' ? nextPage() : prevPage();
      } else if (diffX > 40 || (diffX > 20 && velocity > 0.3)) {
        bookArticle.dir === 'ltr' ? prevPage() : nextPage();
      }
      isHorizontalGesture = false;
      closeTools();
    }, { passive: true });

    window.addEventListener('touchcancel', () => { readerTouchActive=false; isHorizontalGesture=false; });

    // iOS reports several viewport sizes during rotation and browser-bar transitions.
    window.addEventListener('resize', scheduleReflow);
    window.addEventListener('orientationchange', scheduleReflow);
    window.visualViewport?.addEventListener('resize', scheduleReflow);
    new ResizeObserver(() => {
      const rect = columnWindow.getBoundingClientRect();
      if (Math.abs(rect.width - layout.width) > 0.5 || Math.abs(rect.height - layout.height) > 0.5) scheduleReflow();
    }).observe(columnWindow);
    document.fonts?.ready.then(scheduleReflow);

    // Appearance Modal Settings
    const fontRange = document.getElementById('font-size-range');
    if (fontRange) {
      fontRange.addEventListener('input', (e) => {
        applyFontSize(parseInt(e.target.value, 10));
      });
    }

    document.querySelectorAll('.theme-pill-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        applyTheme(btn.dataset.themeVal);
      });
    });

    document.querySelectorAll('.font-choice-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        applyFont(btn.dataset.fontVal);
      });
    });

    document.querySelectorAll('.layout-choice-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        applyLayout(btn.dataset.layoutVal);
      });
    });

    // Search Field
    const searchField = document.getElementById('search-input-field');
    if (searchField) {
      let debounce;
      searchField.addEventListener('input', (e) => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          searchBook(e.target.value);
        }, 250);
      });
    }

    // Modal Close
    document.querySelectorAll('.btn-close-modal, .modal-backdrop').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target === el || el.classList.contains('btn-close-modal') || el.closest('.btn-close-modal')) {
          closeModals();
        }
      });
    });
  }

  // --- Initializer ---
  function init() {
    CHAPTER_METAS = window.BookLibrary.activeBook.toc;
    state.totalPages = window.BookLibrary.activeBook.sourcePages || 1;
    loadState();
    applyTheme(state.theme);
    applyFont(state.font);
    applyFontSize(state.fontSize);
    applyLayout(state.layoutMode);

    initTimelineScrubber();
    initEvents();

    updateCoverButton();

    // Convert older word pins to page markers without modifying the book content.
    if (state.pauseMarker?.paragraphIndex >= 0 && !state.pauseMarker.location) {
      const oldBlock = bookArticle.querySelectorAll('p,h2,h3,li')[state.pauseMarker.paragraphIndex];
      const block = blocks().indexOf(oldBlock);
      if (block >= 0) state.pauseMarker.location = { block, offset: state.pauseMarker.textOffset || 0 };
      delete state.pauseMarker.paragraphIndex; delete state.pauseMarker.textOffset;
    }
    // Start on Modern Clean Cover View
    openCover();
    bookArticle.querySelectorAll('img').forEach(image => image.addEventListener('load', scheduleReflow));
    readerReady();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.BookLibrary.ready.then(init));
  } else {
    window.BookLibrary.ready.then(init);
  }

  // Global Controller
  window.LibbyApp = {
    ready,
    restoreProgress(progress) {
      state.currentPage = progress.page;
      state.readingLocation = progress.location;
      state.pauseMarker = progress.pause;
      recalculatePagination();
      updatePauseMarkerUI();
      updateCoverButton();
      saveState();
    },
    openReader,
    openCover,
    goToPage,
    nextPage,
    prevPage,
    toggleHud,
    applyTheme,
    applyFont,
    applyFontSize,
    recalculatePagination,
    openFootnoteModal,
    setPauseMarker,
    resumeFromPauseMarker,
    clearPauseMarker,
    state
  };
})();
