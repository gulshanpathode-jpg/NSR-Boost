/**
 * content/highlighter.js - transient visual marker for a control.
 *
 * The old site's unit was a <tr>; here it is div.dyn-input-container, so the
 * outline is applied to the container element passed in by content.js.
 */

(() => {
  if (window.__NSR_BOOST_HIGHLIGHTER__) return;
  window.__NSR_BOOST_HIGHLIGHTER__ = true;

  const STYLE_ID = 'nsr-boost-highlight-style';
  const CLASS = 'nsr-boost-flash';

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .${CLASS} {
        outline: 2px solid #2f6fb2 !important;
        outline-offset: 2px;
        background-color: rgba(47, 111, 178, 0.08) !important;
        transition: outline-color .3s ease, background-color .3s ease;
      }
    `;
    document.head.appendChild(style);
  }

  function flash(el, ms = 1800) {
    if (!el) return;
    ensureStyle();
    el.classList.add(CLASS);
    setTimeout(() => el.classList.remove(CLASS), ms);
  }

  function clearAll() {
    document.querySelectorAll(`.${CLASS}`).forEach((el) => el.classList.remove(CLASS));
  }

  window.NSR_HIGHLIGHTER = { flash, clearAll };
})();
