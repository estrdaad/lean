/* Lucide SVG subset (ISC) + Floating UI DOM (MIT). See vendor/manifest.json. */
(function () {
  const icons = {"bookmark": "<svg aria-hidden=\"true\" focusable=\"false\" class=\"reader-icon\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z\" />\n</svg>\n", "bookmark-check": "<svg aria-hidden=\"true\" focusable=\"false\" class=\"reader-icon\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z\" />\n  <path d=\"m9 10 2 2 4-4\" />\n</svg>\n", "library": "<svg aria-hidden=\"true\" focusable=\"false\" class=\"reader-icon\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"m16 6 4 14\" />\n  <path d=\"M12 6v14\" />\n  <path d=\"M8 8v12\" />\n  <path d=\"M4 4v16\" />\n</svg>\n", "menu": "<svg aria-hidden=\"true\" focusable=\"false\" class=\"reader-icon\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"M4 5h16\" />\n  <path d=\"M4 12h16\" />\n  <path d=\"M4 19h16\" />\n</svg>\n", "search": "<svg aria-hidden=\"true\" focusable=\"false\" class=\"reader-icon\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"m21 21-4.34-4.34\" />\n  <circle cx=\"11\" cy=\"11\" r=\"8\" />\n</svg>\n", "list": "<svg aria-hidden=\"true\" focusable=\"false\" class=\"reader-icon\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"M3 5h.01\" />\n  <path d=\"M3 12h.01\" />\n  <path d=\"M3 19h.01\" />\n  <path d=\"M8 5h13\" />\n  <path d=\"M8 12h13\" />\n  <path d=\"M8 19h13\" />\n</svg>\n", "type": "<svg aria-hidden=\"true\" focusable=\"false\" class=\"reader-icon\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"M12 4v16\" />\n  <path d=\"M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2\" />\n  <path d=\"M9 20h6\" />\n</svg>\n", "x": "<svg aria-hidden=\"true\" focusable=\"false\" class=\"reader-icon\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"M18 6 6 18\" />\n  <path d=\"m6 6 12 12\" />\n</svg>\n"};
  window.ReaderIcons = icons;
  function decorate() {
    const mapping = { 'reader-tools-toggle':'menu', 'btn-hud-toc':'list', 'btn-hud-search':'search', 'btn-hud-appearance':'type', 'btn-hud-bookmark':'bookmark', 'saved-page-indicator':'bookmark-check' };
    for (const [id, name] of Object.entries(mapping)) {
      const element = document.getElementById(id);
      if (!element) continue;
      element.innerHTML = icons[name];
      if (id === 'btn-hud-bookmark') {
        const label = document.createElement('span'); label.className = 'control-label'; label.textContent = 'حفظ الصفحة'; element.append(label);
      }
    }
    document.querySelector('#btn-cover-resume-pause svg')?.replaceWith(new DOMParser().parseFromString(icons.bookmark, 'image/svg+xml').documentElement);
    document.querySelectorAll('[data-open-library]').forEach(button => { button.insertAdjacentHTML('afterbegin', icons.library); });
    const toggle = document.getElementById('reader-tools-toggle'), panel = document.getElementById('reader-tools-panel');
    let stop;
    async function position() {
      if (panel.hidden || !window.FloatingUIDOM) return;
      panel.style.width = Math.min(580, window.innerWidth - 24) + 'px';
      const {computePosition, offset, flip, shift, size} = window.FloatingUIDOM;
      const result = await computePosition(toggle, panel, {
        strategy: 'fixed', placement: 'top',
        middleware: [offset(12), flip({padding:12}), shift({padding:12}), size({padding:12, apply({availableHeight}) { panel.style.maxHeight = Math.max(60, availableHeight) + 'px'; }})]
      });
      if (panel.hidden) return;
      Object.assign(panel.style, {left: result.x + 'px', top: result.y + 'px'});
    }
    new MutationObserver(() => {
      stop?.(); stop = null;
      if (!panel.hidden && window.FloatingUIDOM) stop = window.FloatingUIDOM.autoUpdate(toggle, panel, position);
    }).observe(panel, {attributes:true, attributeFilter:['hidden']});
    document.addEventListener('click', event => {
      if (!panel.hidden && !panel.contains(event.target) && !toggle.contains(event.target)) {
        panel.hidden = true; toggle.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !panel.hidden) { panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); toggle.focus(); }
    });
  }
  window.BookLibrary.ready.then(decorate);
})();
