/**
 * Libby E-Reader Engine for "الشركة الناشئة المرنة — إريك ريس"
 * Pure Horizontal Paginated Reader (التقليب الأفقي التام - بدون أي تمرير عمودي)
 * Implements the authentic Libby reading experience:
 * - Clean Modern Flat Cover Presentation (Zero 3D Distortion)
 * - Multi-Column Horizontal Sliding Pages (GPU Transform - Pixel Perfect)
 * - Exact Libby HUD (ص. X من Total, Chapter Name, %, remaining pages)
 * - Interactive Footnote & Citation Viewer Card (Full clickability & popup)
 * - Reading Pause Marker Engine (مؤشر التوقف المؤقت على أي كلمة/فقرة والعودة المباشرة)
 * - Scrubbing Timeline with 28 chapter markers
 * - Appearance Modal (A): Text Scale, Light/Sepia/Dark, Font Selection, Spread/Single
 * - TOC Drawer with instant horizontal page jump
 * - Full Text Search & Bookmarks
 * - Responsive Touch Gestures (Swipes, Edge Taps, HUD toggle)
 */

(function () {
  'use strict';

  const CHAPTER_METAS = [
    { id: 'endorsements', title: 'إشادات بالكتاب' },
    { id: 'copyright', title: 'حقوق النشر' },
    { id: 'dedication', title: 'إهداء' },
    { id: 'contents-page', title: 'محتويات الكتاب' },
    { id: 'acknowledgements', title: 'شكر وتقدير' },
    { id: 'introduction', title: 'مقدمة الكتاب' },
    { id: 'organization', title: 'كيف نُظّم هذا الكتاب' },
    { id: 'part-1', title: 'الجزء الأول: الرؤية' },
    { id: 'chapter-1', title: 'الفصل 1: البداية' },
    { id: 'chapter-2', title: 'الفصل 2: التعريف' },
    { id: 'chapter-3', title: 'الفصل 3: التعلّم' },
    { id: 'chapter-4', title: 'الفصل 4: التجربة' },
    { id: 'part-2', title: 'الجزء الثاني: التوجيه' },
    { id: 'chapter-5', title: 'الفصل 5: القفزة' },
    { id: 'chapter-6', title: 'الفصل 6: الاختبار' },
    { id: 'chapter-7', title: 'الفصل 7: القياس' },
    { id: 'chapter-8', title: 'الفصل 8: تغيير المسار أم المثابرة' },
    { id: 'part-3', title: 'الجزء الثالث: التسريع' },
    { id: 'chapter-9', title: 'الفصل 9: الدفعات' },
    { id: 'chapter-10', title: 'الفصل العاشر: النمو' },
    { id: 'chapter-11', title: 'الفصل الحادي عشر: التكيّف' },
    { id: 'chapter-12', title: 'الفصل الثاني عشر: الابتكار' },
    { id: 'epilogue', title: 'الخاتمة: لا تهدر شيئًا' },
    { id: 'join-movement', title: 'انضم إلى الحركة' },
    { id: 'endnotes', title: 'الحواشي والمراجع' },
    { id: 'disclosures', title: 'إفصاحات' },
    { id: 'acknowledgements-end', title: 'شكر وتقدير' },
    { id: 'about-author', title: 'عن المؤلف' }
  ];

  // Global State
  const state = {
    currentPage: 1,
    totalPages: 296,
    isHudVisible: true,
    theme: 'warm',
    font: 'book',
    fontSize: 19,
    layoutMode: 'single', // 'single' | 'spread'
    bookmarks: {},
    pauseMarker: null, // { page, elementId, snippet, time, timestamp }
    currentChapterTitle: 'غلاف الكتاب',
    chapterPages: []
  };

  // SVGs for dynamic injection
  const SVG_BOOK = `<svg class="libby-svg-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>`;
  const SVG_CHEVRON_LEFT = `<svg class="libby-svg-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>`;
  const SVG_PIN = `<svg class="libby-svg-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>`;
  const SVG_CLOSE_SM = `<svg class="libby-svg-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;


  function saveState() {
    try {
      localStorage.setItem('libby-lean-page', state.currentPage);
      localStorage.setItem('libby-lean-theme', state.theme);
      localStorage.setItem('libby-lean-font', state.font);
      localStorage.setItem('libby-lean-font-size', state.fontSize);
      localStorage.setItem('libby-lean-layout', state.layoutMode);
      localStorage.setItem('libby-lean-bookmarks', JSON.stringify(state.bookmarks));
      if (state.pauseMarker) {
        localStorage.setItem('libby-lean-pause', JSON.stringify(state.pauseMarker));
      } else {
        localStorage.removeItem('libby-lean-pause');
      }
    } catch (e) {
      console.warn('Storage unavailable', e);
    }
  }

  function loadState() {
    try {
      state.currentPage = parseInt(localStorage.getItem('libby-lean-page') || '1', 10);
      state.theme = localStorage.getItem('libby-lean-theme') || 'warm';
      state.font = localStorage.getItem('libby-lean-font') || 'book';
      state.fontSize = parseInt(localStorage.getItem('libby-lean-font-size') || '19', 10);
      state.layoutMode = localStorage.getItem('libby-lean-layout') || 'single';
      const bmarks = localStorage.getItem('libby-lean-bookmarks');
      if (bmarks) state.bookmarks = JSON.parse(bmarks);
      const pause = localStorage.getItem('libby-lean-pause');
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

  // --- Views Controller ---
  function openReader(targetPage) {
    if (viewCover) viewCover.classList.add('hidden');
    if (viewReader) viewReader.classList.add('active');

    // Recalculate horizontal pagination
    setTimeout(() => {
      recalculatePagination();
      const p = targetPage || state.currentPage || 1;
      goToPage(p, false);
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
      if (state.currentPage > 1) {
        textSpan.textContent = `متابعة القراءة • ص. ${state.currentPage}`;
      } else {
        textSpan.textContent = `ابدأ القراءة • ص. 1`;
      }
    }
    updatePauseMarkerUI();
  }

  // --- Horizontal Multi-Column Pagination Engine ---
  function recalculatePagination() {
    if (!columnWindow || !bookArticle) return;

    const windowWidth = Math.floor(columnWindow.clientWidth);
    const windowHeight = Math.floor(columnWindow.clientHeight);
    if (windowWidth <= 0 || windowHeight <= 0) return;

    const gap = 60;
    const isSpread = document.body.classList.contains('mode-spread');

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

    // Clamp current page
    state.currentPage = Math.max(1, Math.min(state.totalPages, state.currentPage));

    applyPageTransform(false);
    updateHudStats();
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
        const diffFromRight = Math.max(0, artRect.right - elRect.right);
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
      return { title: 'مقدمة الكتاب', remaining: 10 };
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
      remaining: remaining
    };
  }

  // --- Horizontal Page Navigation (GPU Transform translateX - 100% Precision) ---
  function applyPageTransform(animate = true) {
    if (!columnsContent || !columnWindow) return;

    const windowWidth = Math.floor(columnWindow.clientWidth);
    const gap = 60;
    const stride = windowWidth + gap;
    const pageIndex = state.currentPage - 1;

    // In Arabic RTL: Column 1 is at 0. Advancing to Column 2 (flowing to the left) shifts content to the RIGHT (+stride * pageIndex)
    const targetX = pageIndex * stride;

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
    state.currentPage = clamped;

    applyPageTransform(animate);
    updateHudStats();
    saveState();
  }

  function nextPage() {
    if (state.currentPage < state.totalPages) {
      goToPage(state.currentPage + 1, true);
    } else {
      showToast('وصلت إلى نهاية الكتاب');
    }
  }

  function prevPage() {
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
    const isBookmarked = !!state.bookmarks[pageNum];
    if (ribbon) ribbon.classList.toggle('is-active', isBookmarked);
    if (bmarkBtn) bmarkBtn.classList.toggle('is-active', isBookmarked);

    updateCoverButton();
  }

  // --- HUD Visibility Toggle ---
  function toggleHud(forceState) {
    if (typeof forceState === 'boolean') {
      state.isHudVisible = forceState;
    } else {
      state.isHudVisible = !state.isHudVisible;
    }

    if (hudTop) hudTop.classList.toggle('hud-hidden', !state.isHudVisible);
    if (hudBottom) hudBottom.classList.toggle('hud-hidden', !state.isHudVisible);
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
    setTimeout(recalculatePagination, 100);
  }

  function applyFontSize(size) {
    state.fontSize = size;
    document.documentElement.style.setProperty('--reader-font-size', `${size}px`);
    const display = document.getElementById('font-size-val-display');
    if (display) display.textContent = `${size}px`;
    const range = document.getElementById('font-size-range');
    if (range && parseInt(range.value, 10) !== size) range.value = size;
    saveState();
    setTimeout(recalculatePagination, 120);
  }

  function applyLayout(mode) {
    mode = 'single';
    state.layoutMode = mode;
    document.body.classList.toggle('mode-spread', mode === 'spread');
    document.querySelectorAll('.layout-choice-btn').forEach(btn => {
      btn.classList.toggle('is-selected', btn.dataset.layoutVal === mode);
    });
    saveState();
    setTimeout(recalculatePagination, 100);
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
      li.innerHTML = `
        <span>${ch.title}</span>
        <span class="toc-page-num">ص. ${page}</span>
      `;
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
        const diffFromRight = Math.max(0, artRect.right - pRect.right);
        const page = Math.floor(diffFromRight / stride) + 1;

        results.push({
          page: Math.max(1, Math.min(state.totalPages, page)),
          text: text
        });
      }
    });

    if (results.length === 0) {
      container.innerHTML = `<p style="text-align:center;color:var(--text-muted);padding:1.5rem;">لم يتم العثور على نتائج مطابقة لـ "${query}"</p>`;
      return;
    }

    container.innerHTML = `<p style="font-size:0.85rem;color:var(--libby-teal);font-weight:700;margin-bottom:0.5rem;">تم العثور على ${results.length} نتيجة مطابقة:</p>`;

    results.slice(0, 30).forEach(r => {
      const item = document.createElement('div');
      item.className = 'search-result-item';

      const regex = new RegExp(`(${query})`, 'gi');
      const highlighted = r.text.length > 200 ? r.text.slice(0, 200) + '...' : r.text;
      const snippet = highlighted.replace(regex, '<mark>$1</mark>');

      item.innerHTML = `
        <div style="font-size:0.75rem;font-weight:700;color:var(--libby-teal);margin-bottom:0.2rem;">صفحة ${r.page}</div>
        <div class="search-snippet">${snippet}</div>
      `;
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
    const p = state.currentPage;

    if (state.bookmarks[p]) {
      delete state.bookmarks[p];
      showToast('تمت إزالة الإشارة المرجعية');
    } else {
      state.bookmarks[p] = {
        page: p,
        chapter: state.currentChapterTitle,
        time: new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' })
      };
      showToast(`تم حفظ ص. ${p} في الإشارات المرجعية`);
    }

    updateHudStats();
    saveState();
    renderBookmarks();
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
          <span style="font-size:0.8rem;color:var(--text-muted);margin-inline-start:0.5rem;">${b.chapter}</span>
        </div>
        <span style="font-size:0.75rem;color:var(--text-muted);">${b.time}</span>
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
      contentEl.innerHTML = `<p>حاشية مرجعية رقم ${noteNum}.</p>`;
    }

    if (jumpBtn) {
      jumpBtn.onclick = () => {
        closeModals();
        if (targetEl) {
          const endnotesCh = state.chapterPages.find(c => c.id === 'endnotes');
          const targetPage = endnotesCh ? endnotesCh.page : state.totalPages;
          goToPage(targetPage, true);
          showToast('انتقلت إلى قسم الحواشي والمراجع في نهاية الكتاب');
        }
      };
    }

    openModal('modal-footnote');
  }

  // --- Reading Pause Marker Engine (مؤشر التوقف المؤقت) ---
  function setPauseMarker(targetElement, caret) {
    const page = state.currentPage;
    let snippet = '';
    let targetEl = targetElement;

    if (!targetEl && columnWindow) {
      // Find visible paragraph in column window
      const winRect = columnWindow.getBoundingClientRect();
      const midX = (winRect.left + winRect.right) / 2;
      const midY = (winRect.top + winRect.bottom) / 2;
      targetEl = document.elementFromPoint(midX, midY);
      if (targetEl && !targetEl.closest('#book-article')) {
        targetEl = document.querySelector('#book-article p');
      }
    }

    if (targetEl) {
      const p = targetEl.closest('p, h2, h3, li') || targetEl;
      const text = (p.textContent || '').trim();
      snippet = text.length > 50 ? text.slice(0, 50) + '...' : text;

      // Clear previous paused elements
      document.querySelectorAll('.libby-paused-element').forEach(el => {
        el.classList.remove('libby-paused-element');
        const oldPin = el.querySelector('.libby-pause-marker-pin');
        if (oldPin) oldPin.remove();
      });

      p.classList.add('libby-paused-element');
      const pin = document.createElement('span');
      pin.className = 'libby-pause-marker-pin';
      pin.innerHTML = `<span>${SVG_PIN}</span> توقفت هنا <span class="btn-remove-pin" title="إزالة">${SVG_CLOSE_SM}</span>`;
      pin.querySelector('.btn-remove-pin').onclick = (e) => {
        e.stopPropagation();
        clearPauseMarker();
      };
      pin.setAttribute('aria-label', 'موضع التوقف، اضغط لإزالته');
      pin.title = 'موضع التوقف — اضغط لإزالته';
      pin.innerHTML = SVG_PIN;
      pin.onclick = (event) => { event.stopPropagation(); clearPauseMarker(); };
      if (caret && p.contains(caret.node) && caret.node.nodeType === Node.TEXT_NODE) {
        const range = document.createRange();
        range.setStart(caret.node, Math.min(caret.offset, caret.node.length));
        range.collapse(true);
        range.insertNode(pin);
      } else { p.prepend(pin); }
    } else {
      snippet = state.currentChapterTitle;
    }

    const now = new Date();
    const timeStr = now.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' });

    state.pauseMarker = {
      page: page,
      snippet: snippet || `صفحة ${page}`,
      time: timeStr,
      timestamp: Date.now(),
      paragraphIndex: Array.from(bookArticle.querySelectorAll('p,h2,h3,li')).indexOf(targetEl && (targetEl.closest('p,h2,h3,li') || targetEl)),
      textOffset: caret ? caret.absoluteOffset : 0
    };

    saveState();
    updatePauseMarkerUI();
    showToast(`تم وضع مؤشر التوقف في صفحة ${page}`);
  }

  function resumeFromPauseMarker() {
    if (!state.pauseMarker) {
      showToast('لا يوجد موضع توقف محفوظ');
      return;
    }
    const targetPage = state.pauseMarker.page;
    openReader(targetPage);
    setTimeout(() => {
      const savedPin = document.querySelector('.libby-pause-marker-pin');
      let resumePage = targetPage;
      if(savedPin && columnWindow) {
        const rect = savedPin.getBoundingClientRect();
        const windowRect = columnWindow.getBoundingClientRect();
        resumePage = state.currentPage + Math.round((windowRect.right - rect.right) / columnWindow.clientWidth);
      }
      goToPage(resumePage, false);
      const paused = document.querySelector('.libby-paused-element');
      if (paused) {
        paused.classList.remove('libby-paused-element');
        void paused.offsetWidth; // trigger reflow
        paused.classList.add('libby-paused-element');
      }
      showToast(`عدت إلى موضع توقفك (ص. ${targetPage})`);
    }, 120);
  }

  function clearPauseMarker() {
    state.pauseMarker = null;
    document.querySelectorAll('.libby-paused-element').forEach(el => {
      el.classList.remove('libby-paused-element');
      const pin = el.querySelector('.libby-pause-marker-pin');
      if (pin) pin.remove();
    });
    saveState();
    updatePauseMarkerUI();
    showToast('تمت إزالة مؤشر التوقف');
  }

  function updatePauseMarkerUI() {
    const banner = document.getElementById('cover-pause-banner');
    const snippetEl = document.getElementById('cover-pause-snippet');
    const cornerMarker = document.getElementById('pause-corner-marker');
    const hudPauseBtn = document.getElementById('btn-hud-pause');

    if (state.pauseMarker) {
      if (banner) banner.style.display = 'flex';
      if (snippetEl) snippetEl.textContent = `ص. ${state.pauseMarker.page} • «${state.pauseMarker.snippet}»`;
      if (cornerMarker) {
        cornerMarker.style.display = 'inline-flex';
        cornerMarker.title = `موضع التوقف في ص. ${state.pauseMarker.page} (اضغط للمتابعة)`;
      }
      if (hudPauseBtn) {
        hudPauseBtn.classList.add('is-active');
        hudPauseBtn.title = `موضع توقف محفوظ في ص. ${state.pauseMarker.page} (اضغط لتغيير الموضع)`;
      }
    } else {
      if (banner) banner.style.display = 'none';
      if (cornerMarker) cornerMarker.style.display = 'none';
      if (hudPauseBtn) {
        hudPauseBtn.classList.remove('is-active');
        hudPauseBtn.title = 'مؤشر التوقف المؤقت (اضغط للتوقف عند هذه الصفحة)';
      }
    }
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
      startReadingBtn.addEventListener('click', () => openReader(state.currentPage));
    }

    const coverResumePauseBtn = document.getElementById('btn-cover-resume-pause');
    if (coverResumePauseBtn) {
      coverResumePauseBtn.addEventListener('click', resumeFromPauseMarker);
    }

    const cornerPauseMarker = document.getElementById('pause-corner-marker');
    if (cornerPauseMarker) {
      cornerPauseMarker.addEventListener('click', resumeFromPauseMarker);
    }

    const browseTocBtn = document.getElementById('btn-browse-toc');
    if (browseTocBtn) {
      browseTocBtn.addEventListener('click', () => {
        renderToc();
        openModal('modal-toc');
      });
    }

    // Reader Top HUD Actions
    const backBtn = document.getElementById('reader-back-btn');
    if (backBtn) {
      backBtn.addEventListener('click', openCover);
    }

    const btnPause = document.getElementById('btn-hud-pause');
    if (btnPause) {

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

      // 2. Pause Pin Remove button
      if (e.target.closest('.btn-remove-pin')) {
        e.preventDefault();
        e.stopPropagation();
        clearPauseMarker();
        return;
      }
    });

    const toolsToggle = document.getElementById('reader-tools-toggle');
    const toolsPanel = document.getElementById('reader-tools-panel');
    toolsPanel.append(document.getElementById('reader-hud-top'), document.getElementById('reader-hud-bottom'));
    const closeTools = () => { toolsPanel.hidden = true; toolsToggle.setAttribute('aria-expanded', 'false'); };
    toolsToggle.addEventListener('click', () => {
      toolsPanel.hidden = !toolsPanel.hidden;
      toolsToggle.setAttribute('aria-expanded', String(!toolsPanel.hidden));
    });
    toolsPanel.addEventListener('click', e => { if (e.target.closest('button')) closeTools(); });
    let pinPlacement = false;
    btnPause.addEventListener('click', () => {
      pinPlacement = true;
      showToast('اضغط بجانب الكلمة لحفظ موضع التوقف');
    });
    function caretAt(x, y) {
      let node, offset;
      if (document.caretPositionFromPoint) { const c = document.caretPositionFromPoint(x,y); if(c) {node=c.offsetNode;offset=c.offset;} }
      else if(document.caretRangeFromPoint) { const r=document.caretRangeFromPoint(x,y); if(r) {node=r.startContainer;offset=r.startOffset;} }
      if(!node || !bookArticle.contains(node)) return null;
      const parent=node.parentElement.closest('p,h2,h3,li');
      if(!parent) return null;
      const r=document.createRange();r.selectNodeContents(parent);r.setEnd(node,offset);
      return {node,offset,absoluteOffset:r.toString().length};
    }
    // Double-click or paragraph click for Pause Pin
    if (bookArticle) {
      bookArticle.addEventListener('dblclick', (e) => {
        const p = e.target.closest('p, h2, h3');
        if (p) {
          setPauseMarker(p, caretAt(e.clientX, e.clientY));
        }
      });
    }

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
        if (matchMedia('(pointer: coarse)').matches || pinPlacement) {
          if(e.target.closest('a,button,.libby-pause-marker-pin')) return;
          if(pinPlacement) { const caret=caretAt(e.clientX,e.clientY); if(caret) { setPauseMarker(caret.node.parentElement,caret);pinPlacement=false; } }
          return;
        }
        // Ignore clicks on links, buttons, form inputs, footnote markers, or pause pins
        if (e.target.closest('a, button, input, select, textarea, .footnote-ref, .footnote-link, .btn-remove-pin, .libby-pause-marker-pin')) return;
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
      if (!viewReader || !viewReader.classList.contains('active')) return;

      if (e.key === 'ArrowLeft') {
        // RTL: Next page
        nextPage();
      } else if (e.key === 'ArrowRight') {
        // RTL: Previous page
        prevPage();
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
      if (!viewReader || !viewReader.classList.contains('active')) return;
      if (e.target.closest('button, a, input, select, textarea, .modal-backdrop, .modal-sheet')) return;

      if(e.touches.length !== 1) {isHorizontalGesture=false;return;}
      readerTouchActive = true;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchStartTime = Date.now();
      isHorizontalGesture = false;
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      if(!readerTouchActive) return;
      if (!viewReader || !viewReader.classList.contains('active')) return;
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
      if (!viewReader || !viewReader.classList.contains('active')) return;
      if (!isHorizontalGesture) return;

      const diffX = e.changedTouches[0].clientX - touchStartX;
      const duration = Date.now() - touchStartTime;
      const velocity = Math.abs(diffX) / Math.max(1, duration);

      // In Arabic RTL:
      // Swipe left returns to the previous Arabic page.
      // Swipe right advances to the next Arabic page.
      if (diffX < -40 || (diffX < -20 && velocity > 0.3)) {
        prevPage();
      } else if (diffX > 40 || (diffX > 20 && velocity > 0.3)) {
        nextPage();
      }
      isHorizontalGesture = false;
      closeTools();
    }, { passive: true });

    window.addEventListener('touchcancel', () => { readerTouchActive=false; isHorizontalGesture=false; });

    // Window Resize -> Recalculate columns
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        recalculatePagination();
      }, 150);
    });

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
    loadState();
    applyTheme(state.theme);
    applyFont(state.font);
    applyFontSize(state.fontSize);
    applyLayout(state.layoutMode);

    initTimelineScrubber();
    initEvents();

    updateCoverButton();

    if (state.pauseMarker && Number.isInteger(state.pauseMarker.paragraphIndex) && state.pauseMarker.paragraphIndex >= 0) {
      const p = bookArticle.querySelectorAll('p,h2,h3,li')[state.pauseMarker.paragraphIndex];
      if(p) {
        let remaining=state.pauseMarker.textOffset || 0;
        const walker=document.createTreeWalker(p,NodeFilter.SHOW_TEXT);
        let node;
        while((node=walker.nextNode())) {
          if(remaining<=node.length) {
            const range=document.createRange();range.setStart(node,remaining);range.collapse(true);
            const pin=document.createElement('span');pin.className='libby-pause-marker-pin';pin.innerHTML=SVG_PIN;
            pin.title='موضع التوقف — اضغط لإزالته';pin.onclick=e=>{e.stopPropagation();clearPauseMarker();};
            range.insertNode(pin);p.classList.add('libby-paused-element');break;
          }
          remaining-=node.length;
        }
      }
    }
    // Start on Modern Clean Cover View
    openCover();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Global Controller
  window.LibbyApp = {
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
