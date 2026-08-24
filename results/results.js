/**
 * results/results.js - Renderer for the standalone image-description tab.
 *
 * Data handoff:
 *   The side panel stashes the payload in chrome.storage.local under a
 *   per-call key, then opens this tab with that key in the URL fragment:
 *     results.html#<encoded-key>
 *   On load we read + delete that entry so a refresh doesn't double-render
 *   stale data.
 *
 * If the storage read fails or returns nothing, we leave the loading state
 * visible but swap the message to something diagnostic - this is the most
 * common "results page didn't open right" symptom and the user shouldn't
 * have to dig through DevTools to see why.
 *
 * Interactivity:
 *   The result set is rendered through a small view layer (search / filter /
 *   sort) so an operator scanning a 60+ photo survey can jump straight to the
 *   changed labels, search a description, or reorder the grid - without ever
 *   mutating the underlying data (so toggling controls is lossless).
 */

'use strict';

// View state for the search / filter / sort toolbar. `items` is the full,
// immutable result set (each entry tagged with its original page order);
// every render derives a filtered + sorted *view* from it, so toggling
// controls never mutates or loses data.
const view = {
  items: [],
  thumbnails: {},
  search: '',
  filter: 'all',   // 'all' | 'correct' | 'changed'
  sort: 'order',   // 'order' | 'changed' | 'label-asc' | 'label-desc'
};

document.addEventListener('DOMContentLoaded', loadFromStorage);

function loadFromStorage() {
  const rawHash = (location.hash || '').replace(/^#/, '');
  const key = rawHash ? decodeURIComponent(rawHash) : '';

  if (!key) {
    setLoadingMessage('No results key in URL - this page must be opened from the Boost USA side panel.');
    return;
  }

  chrome.storage.local.get(key, (entry) => {
    if (chrome.runtime.lastError) {
      setLoadingMessage('Could not read results: ' + chrome.runtime.lastError.message);
      return;
    }
    if (!entry || !entry[key]) {
      setLoadingMessage('Results data not found. Try running the verification again.');
      return;
    }
    renderResults(entry[key]);
    chrome.storage.local.remove(key).catch(() => {});
  });
}

function setLoadingMessage(message) {
  const loading = document.getElementById('loadingState');
  const p = loading?.querySelector('p');
  if (p) p.textContent = message;
}

function renderResults(data) {
  document.getElementById('loadingState').style.display    = 'none';
  document.getElementById('resultsContainer').style.display = 'flex';

  // ── Survey metadata ─────────────────────────────────────────────
  const meta = data.meta || {};
  document.getElementById('rSurvey').textContent  = meta.surveyNumber || '-';
  document.getElementById('rInsured').textContent = meta.insuredName  || '-';
  document.getElementById('rPolicy').textContent  = meta.policyNumber || '-';

  // ── Stats ───────────────────────────────────────────────────────
  const results    = Array.isArray(data.results) ? data.results : [];
  const thumbnails = data.thumbnails || {};
  const total      = results.length;
  const correct    = results.filter((r) => r.isCorrect).length;
  const incorrect  = total - correct;

  document.getElementById('statTotalText').textContent     = `${total} Total`;
  document.getElementById('statCorrectText').textContent   = `${correct} Correct`;
  document.getElementById('statIncorrectText').textContent = `${incorrect} Changed`;

  // Heading subtitle ("65 images")
  document.getElementById('rResultsCount').textContent =
    `${total} image${total === 1 ? '' : 's'} verified`;

  // Overall badge: green if everything matched, otherwise warn-ish
  const overallBadge = document.getElementById('rOverallBadge');
  if (incorrect === 0) {
    overallBadge.className   = 'badge badge-success';
    overallBadge.textContent = 'ALL VERIFIED';
  } else {
    overallBadge.className   = 'badge badge-danger';
    overallBadge.textContent = `${incorrect} CHANGED`;
  }

  // ── Seed view state ─────────────────────────────────────────────
  // Tag each item with its original page order so the "#n" badge and the
  // "Page order" sort stay stable no matter how the list is filtered/sorted.
  view.items      = results.map((r, i) => ({ ...r, _order: i }));
  view.thumbnails = thumbnails;

  // Filter-control counts (these reflect the whole set, never the search).
  document.getElementById('segCountAll').textContent     = total;
  document.getElementById('segCountCorrect').textContent = correct;
  document.getElementById('segCountChanged').textContent = incorrect;

  // If there's nothing at all, hide the toolbar and show the empty state.
  const toolbar = document.getElementById('resultsToolbar');
  if (total === 0) {
    if (toolbar) toolbar.style.display = 'none';
    document.getElementById('resultsMeta').textContent = '';
    renderEmptyState('No results to display',
      'The image-verify API returned an empty result set.');
    return;
  }

  wireToolbar();
  applyView();
}

/** Wire the search box, filter segments, and sort dropdown (idempotent). */
function wireToolbar() {
  if (wireToolbar._done) return;
  wireToolbar._done = true;

  const searchEl = document.getElementById('tbSearch');
  const clearEl  = document.getElementById('tbClear');

  searchEl.addEventListener('input', () => {
    view.search = searchEl.value.trim();
    clearEl.classList.toggle('is-visible', searchEl.value.length > 0);
    applyView();
  });
  // Esc clears the search quickly while the operator is scanning.
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchEl.value) {
      searchEl.value = '';
      view.search = '';
      clearEl.classList.remove('is-visible');
      applyView();
    }
  });
  clearEl.addEventListener('click', () => {
    searchEl.value = '';
    view.search = '';
    clearEl.classList.remove('is-visible');
    searchEl.focus();
    applyView();
  });

  document.getElementById('tbFilter').addEventListener('click', (e) => {
    const btn = e.target.closest('.tb-seg-btn');
    if (!btn) return;
    view.filter = btn.dataset.filter;
    document.querySelectorAll('#tbFilter .tb-seg-btn').forEach((b) => {
      const on = b === btn;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    applyView();
  });

  document.getElementById('tbSort').addEventListener('change', (e) => {
    view.sort = e.target.value;
    applyView();
  });
}

/** Recompute the filtered + sorted view and repaint the grid + count line. */
function applyView() {
  const q = view.search.toLowerCase();

  const list = view.items.filter((r) => {
    if (view.filter === 'correct' && !r.isCorrect) return false;
    if (view.filter === 'changed' && r.isCorrect)  return false;
    if (!q) return true;
    return (
      (r.originalLabel    || '').toLowerCase().includes(q) ||
      (r.verifiedLabel    || '').toLowerCase().includes(q) ||
      (r.modelDescription || '').toLowerCase().includes(q) ||
      (r.photoId          || '').toLowerCase().includes(q)
    );
  });

  const labelOf = (r) => (r.verifiedLabel || r.originalLabel || '').toLowerCase();
  list.sort((a, b) => {
    switch (view.sort) {
      case 'changed':    // changed items first, then by page order
        if (a.isCorrect !== b.isCorrect) return a.isCorrect ? 1 : -1;
        return a._order - b._order;
      case 'label-asc':  return labelOf(a).localeCompare(labelOf(b));
      case 'label-desc': return labelOf(b).localeCompare(labelOf(a));
      case 'order':
      default:           return a._order - b._order;
    }
  });

  renderGrid(list);
  renderMeta(list.length);
}

/** "Showing X of Y" line, with context about the active filter/search. */
function renderMeta(shown) {
  const meta = document.getElementById('resultsMeta');
  const total = view.items.length;
  const bits = [`Showing <strong>${shown}</strong> of <strong>${total}</strong>`];
  if (view.filter !== 'all') bits.push(view.filter === 'correct' ? 'correct' : 'changed');
  if (view.search) bits.push(`matching “${escapeHtml(view.search)}”`);
  meta.innerHTML = bits.join(' ');
}

function renderEmptyState(title, sub) {
  const grid = document.getElementById('resultsGrid');
  grid.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.innerHTML = `
    <div class="empty-icon">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="1.6"
           stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <circle cx="8.5" cy="8.5" r="1.5"/>
        <polyline points="21 15 16 10 5 21"/>
      </svg>
    </div>
    <p>${escapeHtml(title)}</p>
    <span>${escapeHtml(sub)}</span>
  `;
  grid.appendChild(empty);
}

function renderGrid(list) {
  const grid = document.getElementById('resultsGrid');
  grid.innerHTML = '';

  if (list.length === 0) {
    renderEmptyState('No matching photos',
      'Try a different search term or switch the filter back to All.');
    return;
  }

  const thumbnails = view.thumbnails;

  list.forEach((result) => {
    const index    = result._order;
    const thumbUrl = thumbnails[result.photoId] || '';
    const fullUrl  = thumbnails[result.photoId + '_full'] || thumbUrl;

    const card = document.createElement('div');
    card.className = 'result-card';

    const badgeClass = result.isCorrect ? 'badge-success' : 'badge-danger';
    const badgeText  = result.isCorrect ? '✓ Correct' : '✗ Changed';

    card.innerHTML = `
      <div class="card-image" title="Click to open full resolution">
        <div class="order-badge">#${index + 1}</div>
        <img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(result.originalLabel || '')}" loading="lazy" />
      </div>
      <div class="card-body">
        <div class="label-row">
          <span class="label-tag">Original</span>
          <span class="label-value">${highlight(result.originalLabel || '')}</span>
        </div>
        <div class="label-row">
          <span class="label-tag">Verified</span>
          <span class="label-value">${highlight(result.verifiedLabel || '')}</span>
        </div>
        <div class="label-changed-row">
          <span class="label-tag">Label</span>
          <span class="badge ${badgeClass}">${badgeText}</span>
        </div>
        <div class="description-box">
          <div class="desc-label">Description</div>
          <div class="desc-text">${highlight(result.modelDescription || 'No description available.')}</div>
        </div>
        <div class="photo-id-text">${highlight(result.photoId || '')}</div>
      </div>
    `;

    const imgArea = card.querySelector('.card-image');
    imgArea.addEventListener('click', () => {
      if (fullUrl) openLightbox(fullUrl, result.originalLabel || '');
    });

    grid.appendChild(card);
  });
}

/**
 * In-page image viewer with zoom + pan. Opens the full-resolution photo in a
 * lightbox overlay on this same page (no new tab), mirroring the on-page modal
 * used for the Order Photos / reference-photo galleries (content/imageModal.js):
 *   · scroll wheel  → zoom toward/away
 *   · +/- buttons or keys → step zoom
 *   · drag          → pan when zoomed in
 *   · ⤢ / 0 / double-click → fit to screen
 *   · backdrop click, × button, or Esc → close
 */
const lightbox = {
  MIN_SCALE: 0.25,
  MAX_SCALE: 8,
  STEP: 0.25,          // button / key zoom increment
  WHEEL_STEP: 0.0015,  // wheel sensitivity (per deltaY unit)
  scale: 1, tx: 0, ty: 0,
  dragging: false,
  dragStartX: 0, dragStartY: 0,
  panStartX: 0, panStartY: 0,
  overlay: null, stage: null, img: null, label: null,
};

function openLightbox(url, alt) {
  const lb = lightbox;
  if (!lb.overlay) return;

  lb.img.src = url;
  lb.img.alt = alt || 'Full resolution photo';
  resetLightboxView();
  lb.overlay.classList.add('is-open');
  document.addEventListener('keydown', onLightboxKeydown);
}

function closeLightbox() {
  const lb = lightbox;
  if (!lb.overlay) return;
  lb.overlay.classList.remove('is-open');
  if (lb.img) lb.img.removeAttribute('src');   // free the decoded image
  lb.dragging = false;
  if (lb.stage) lb.stage.classList.remove('is-dragging');
  document.removeEventListener('keydown', onLightboxKeydown);
}

function clampLightboxScale(s) {
  return Math.min(lightbox.MAX_SCALE, Math.max(lightbox.MIN_SCALE, s));
}

function applyLightboxTransform() {
  const lb = lightbox;
  if (!lb.img) return;
  lb.img.style.transform = `translate(${lb.tx}px, ${lb.ty}px) scale(${lb.scale})`;
  if (lb.label) lb.label.textContent = `${Math.round(lb.scale * 100)}%`;
}

// Fit-to-screen: reset zoom + pan to the default centered view.
function resetLightboxView() {
  lightbox.scale = 1; lightbox.tx = 0; lightbox.ty = 0;
  applyLightboxTransform();
}

function zoomLightboxBy(delta) {
  const lb = lightbox;
  lb.scale = clampLightboxScale(lb.scale + delta);
  if (lb.scale === 1) { lb.tx = 0; lb.ty = 0; }   // snap pan back when fully zoomed out
  applyLightboxTransform();
}

function onLightboxKeydown(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); }
  else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomLightboxBy(lightbox.STEP); }
  else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomLightboxBy(-lightbox.STEP); }
  else if (e.key === '0') { e.preventDefault(); resetLightboxView(); }
}

function onLightboxWheel(e) {
  e.preventDefault();
  zoomLightboxBy(-e.deltaY * lightbox.WHEEL_STEP);
}

function onLightboxPointerDown(e) {
  if (e.button !== 0) return;
  const lb = lightbox;
  lb.dragging = true;
  lb.dragStartX = e.clientX;
  lb.dragStartY = e.clientY;
  lb.panStartX = lb.tx;
  lb.panStartY = lb.ty;
  if (lb.stage) lb.stage.classList.add('is-dragging');
}

function onLightboxPointerMove(e) {
  const lb = lightbox;
  if (!lb.dragging) return;
  lb.tx = lb.panStartX + (e.clientX - lb.dragStartX);
  lb.ty = lb.panStartY + (e.clientY - lb.dragStartY);
  applyLightboxTransform();
}

function onLightboxPointerUp() {
  const lb = lightbox;
  lb.dragging = false;
  if (lb.stage) lb.stage.classList.remove('is-dragging');
}

// Wire the lightbox controls once (close, zoom, drag, backdrop dismiss).
document.addEventListener('DOMContentLoaded', () => {
  const lb = lightbox;
  lb.overlay = document.getElementById('lightbox');
  lb.stage   = document.getElementById('lightboxStage');
  lb.img     = document.getElementById('lightboxImg');
  lb.label   = document.getElementById('lightboxZoomLabel');
  if (!lb.overlay) return;

  document.getElementById('lightboxClose').addEventListener('click', closeLightbox);
  document.getElementById('lightboxZoomIn').addEventListener('click', () => zoomLightboxBy(lb.STEP));
  document.getElementById('lightboxZoomOut').addEventListener('click', () => zoomLightboxBy(-lb.STEP));
  document.getElementById('lightboxReset').addEventListener('click', resetLightboxView);

  // Backdrop click closes. Clicking the image itself must NOT close, so we
  // only dismiss when the target is the overlay or the empty stage area.
  lb.overlay.addEventListener('click', (e) => {
    if (e.target === lb.overlay || e.target === lb.stage) closeLightbox();
  });

  // Zoom + pan interactions live on the stage.
  lb.stage.addEventListener('wheel', onLightboxWheel, { passive: false });
  lb.stage.addEventListener('pointerdown', onLightboxPointerDown);
  lb.stage.addEventListener('dblclick', resetLightboxView);
  // Track move/up on window so a fast drag that leaves the stage still works.
  window.addEventListener('pointermove', onLightboxPointerMove);
  window.addEventListener('pointerup', onLightboxPointerUp);
});

/**
 * HTML-escape `str`, then wrap any occurrences of the active search term in
 * <mark>. Escaping happens first so the highlight can never inject markup -
 * the needle is matched against (and re-inserted into) already-escaped text.
 */
function highlight(str) {
  const safe = escapeHtml(str);
  const q = view.search;
  if (!q) return safe;
  const needle = escapeHtml(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(needle, 'gi'), (m) => `<mark class="hl">${m}</mark>`);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}
