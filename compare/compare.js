/**
 * compare/compare.js - renderer for the standalone answer-comparison report.
 *
 * Data handoff (identical contract to results/results.js):
 *   The side panel stashes the payload in chrome.storage.local under a
 *   per-call key, then opens this tab with that key in the URL fragment:
 *     compare.html#<encoded-key>
 *   On load we read + delete that entry so a refresh doesn't re-render
 *   stale data.
 *
 * What this page is for:
 *   The side-panel queue shows one question at a time in a 360px column and
 *   prints only the CHOSEN label - never the option list the inspector
 *   actually saw. That is fine for deciding and useless for auditing. Here
 *   every question is redrawn in the LC360 idiom (the real option list, as
 *   the same radio / checkbox / textbox control the site renders) once per
 *   answer source, so the values line up option-for-option:
 *
 *     Current form value      what LC360 has saved right now
 *     Page / Form suggestion  AI answer derived from the form pages
 *     AI suggestion           AI answer derived from the inspection photos
 *
 *   Nothing here is an input. The controls are drawn with <div>s rather
 *   than real <input>s on purpose: this is a document, and a focusable
 *   radio would invite a reviewer to think they were editing the form.
 *
 * Export:
 *   "Export PDF" prints the CURRENT VIEW (search + filter applied) through
 *   the browser's own print pipeline, with Save as PDF as the destination.
 *   The print stylesheet in compare.html does the layout work; exportPdf()
 *   only stamps the scope and the filename. See the note above wireExport()
 *   for why this is not a Word export.
 */

'use strict';

// Immutable payload + the view controls layered on top of it. Every render
// derives a filtered view from `sections`; nothing mutates it, so toggling
// a filter is always lossless.
const view = {
  meta: {},
  sections: [],
  search: '',
  filter: 'all',   // 'all' | 'different' | 'matched'
};

document.addEventListener('DOMContentLoaded', () => {
  loadFromStorage();
  wireToolbar();
  wireExport();
  wireThumbFallback();
});

/**
 * Drop any source-photo thumbnail that fails to load.
 *
 * This tab is chrome-extension:// and the photo handler is on the LC360
 * origin, so whether the image resolves depends on the reader's cookies
 * being sent cross-site - which is exactly the kind of thing a browser
 * policy change or a signed-out reader takes away. The link and the URL
 * beneath it still work in that case, so a failed thumbnail should vanish
 * rather than leave a broken-image glyph next to good information.
 *
 * Capture phase and delegated: `error` does not bubble, and the rows are
 * re-rendered on every filter change, so per-element listeners would have
 * to be re-attached each time.
 */
function wireThumbFallback() {
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img && img.classList && img.classList.contains('lc-photo-thumb')) {
      img.remove();
    }
  }, true);
}

// ─────────────────────────────────────────────────────────────────────
// 1  Load
// ─────────────────────────────────────────────────────────────────────

function loadFromStorage() {
  const rawHash = (location.hash || '').replace(/^#/, '');
  const key = rawHash ? decodeURIComponent(rawHash) : '';

  if (!key) {
    setLoadingMessage('No comparison key in URL - this page must be opened from the Boost USA side panel.');
    return;
  }

  chrome.storage.local.get(key, (entry) => {
    if (chrome.runtime.lastError) {
      setLoadingMessage('Could not read comparison data: ' + chrome.runtime.lastError.message);
      return;
    }
    if (!entry || !entry[key]) {
      setLoadingMessage('Comparison data not found. Try running Sync again, then press Compare.');
      return;
    }
    render(entry[key]);
    chrome.storage.local.remove(key).catch(() => { });
  });
}

function setLoadingMessage(message) {
  const p = document.querySelector('#loadingState p');
  if (p) p.textContent = message;
  const spinner = document.querySelector('#loadingState .spinner');
  if (spinner) spinner.style.display = 'none';
}

function render(data) {
  view.meta = data.meta || {};
  view.sections = Array.isArray(data.sections) ? data.sections : [];

  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('reportContainer').style.display = 'flex';

  renderMeta();
  renderStats();
  renderSections();

  const survey = view.meta.surveyNumber ? ` · Survey ${view.meta.surveyNumber}` : '';
  document.title = `Boost USA - Answer Comparison${survey}`;
  const sub = document.getElementById('cHeaderSub');
  if (sub) sub.textContent = (view.meta.formName || 'Smart Fill') + (survey ? ` — Survey ${view.meta.surveyNumber}` : '');
}

// ─────────────────────────────────────────────────────────────────────
// 2  Value helpers
// ─────────────────────────────────────────────────────────────────────

const norm = (v) => String(v == null ? '' : v).trim();
const keyOf = (v) => norm(v).toLowerCase();

/**
 * Selected option labels as a Set of comparison keys. Accepts either the
 * string a radio / select / text control carries or the array a checkbox
 * control carries.
 */
function toSelectedSet(value) {
  const set = new Set();
  if (Array.isArray(value)) {
    value.forEach((v) => { const k = keyOf(v); if (k) set.add(k); });
  } else {
    const k = keyOf(value);
    if (k) set.add(k);
  }
  return set;
}

/** Original-cased labels for a value, keyed for lookup against options. */
function labelsOf(value) {
  const out = new Map();
  const push = (v) => { const k = keyOf(v); if (k) out.set(k, norm(v)); };
  if (Array.isArray(value)) value.forEach(push);
  else push(value);
  return out;
}

function isChoice(inputType) {
  return inputType === 'radio' || inputType === 'checkbox';
}

/** Human-readable rendering of any answer, used for search + export text. */
function formatAnswer(value) {
  if (Array.isArray(value)) return value.filter((v) => norm(v)).join(', ');
  return norm(value);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The answer sources to draw for one question, left to right.
 *
 * Current always leads. Unlike the side panel - which merges the two AI
 * passes into a single "Verified" block when they agree - both passes keep
 * their own column here even in agreement. Collapsing them is right for a
 * decision surface and wrong for an audit one: a reader of this report is
 * asking "what did each source say", and a merged column cannot answer it.
 * Agreement is surfaced as a chip on the head instead.
 */
function columnsFor(q) {
  const cols = [{
    kind: 'current',
    title: 'Current form value',
    helper: 'The answer currently saved on the inspection form.',
    value: q.currentAnswer,
  }];
  if (q.formPass) {
    cols.push({
      kind: 'form',
      title: 'Page / Form suggestion',
      helper: 'This answer was extracted from the inspection form pages.',
      value: q.formPass.answer,
    });
  }
  if (q.imagePass) {
    cols.push({
      kind: 'image',
      title: 'AI suggestion',
      helper: 'This answer was identified from uploaded inspection images.',
      value: q.imagePass.answer,
    });
  }
  return cols;
}

/** Do the two AI passes agree? Order-independent for checkboxes. */
function passesAgree(q) {
  if (!q.formPass || !q.imagePass) return false;
  const a = toSelectedSet(q.formPass.answer);
  const b = toSelectedSet(q.imagePass.answer);
  if (isChoice(q.inputType)) {
    if (a.size !== b.size) return false;
    for (const k of a) if (!b.has(k)) return false;
    return true;
  }
  return keyOf(q.formPass.answer) === keyOf(q.imagePass.answer);
}

// ─────────────────────────────────────────────────────────────────────
// 3  Header cards
// ─────────────────────────────────────────────────────────────────────

function renderMeta() {
  const m = view.meta;
  const items = [
    ['Form', m.formName || '-'],
    ['Survey number', m.surveyNumber || '-'],
    ['Survey type', m.surveyType || '-'],
    ['Location', m.address || '-'],
    ['Result ID', m.resultId || '-'],
    ['Generated', formatTimestamp(m.generatedAt)],
  ];
  document.getElementById('cMetaGrid').innerHTML = items.map(([label, value]) => `
    <div class="meta-item">
      <div class="meta-label">${escapeHtml(label)}</div>
      <div class="meta-value">${escapeHtml(value)}</div>
    </div>
  `).join('');
}

function formatTimestamp(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleString();
}

function allQuestions() {
  return view.sections.reduce((acc, s) => acc.concat(s.questions || []), []);
}

function renderStats() {
  const qs = allQuestions();
  const different = qs.filter((q) => !q.matchesCurrent).length;
  const matched = qs.length - different;

  document.getElementById('cStats').innerHTML = `
    <div class="stat-pill"><span class="stat-num">${qs.length}</span>
      <span class="stat-label">question${qs.length === 1 ? '' : 's'}</span></div>
    <div class="stat-pill is-diff"><span class="stat-num">${different}</span>
      <span class="stat-label">different from the form</span></div>
    <div class="stat-pill is-match"><span class="stat-num">${matched}</span>
      <span class="stat-label">already matching</span></div>
    <div class="stat-pill"><span class="stat-num">${view.sections.length}</span>
      <span class="stat-label">section${view.sections.length === 1 ? '' : 's'}</span></div>
  `;

  document.getElementById('cCountAll').textContent = qs.length;
  document.getElementById('cCountDifferent').textContent = different;
  document.getElementById('cCountMatched').textContent = matched;
}

// ─────────────────────────────────────────────────────────────────────
// 4  View filtering
// ─────────────────────────────────────────────────────────────────────

function matchesFilter(q) {
  if (view.filter === 'different') return !q.matchesCurrent;
  if (view.filter === 'matched') return !!q.matchesCurrent;
  return true;
}

/**
 * Free-text search across everything a reader can see on the card: the
 * question, where it sits, every answer, and every option label. Searching
 * only the question text would miss "find me the questions that mention
 * sprinkler in an answer", which is the actual reason to search a report.
 */
function matchesSearch(q, sectionText) {
  const needle = view.search.trim().toLowerCase();
  if (!needle) return true;
  const hay = [
    q.questionText,
    q.subheader,
    sectionText,
    formatAnswer(q.currentAnswer),
    q.formPass ? formatAnswer(q.formPass.answer) : '',
    q.imagePass ? formatAnswer(q.imagePass.answer) : '',
    (q.options || []).map((o) => o.label).join(' '),
  ].join(' ').toLowerCase();
  return hay.includes(needle);
}

/** Sections with their question lists narrowed; empty sections dropped. */
function visibleSections() {
  return view.sections
    .map((s) => ({
      text: s.text,
      questions: (s.questions || []).filter((q) => matchesFilter(q) && matchesSearch(q, s.text)),
    }))
    .filter((s) => s.questions.length > 0);
}

// ─────────────────────────────────────────────────────────────────────
// 5  Question rendering (the LC360 imitation)
// ─────────────────────────────────────────────────────────────────────

function renderSections() {
  const sections = visibleSections();
  const shown = sections.reduce((n, s) => n + s.questions.length, 0);
  const total = allQuestions().length;

  const metaLine = document.getElementById('cViewMeta');
  metaLine.textContent = shown === total
    ? `Showing all ${total} question${total === 1 ? '' : 's'}`
    : `Showing ${shown} of ${total} questions`;

  const host = document.getElementById('cSections');

  if (sections.length === 0) {
    host.innerHTML = `
      <div class="card empty-state">
        <p>No questions match</p>
        <span>Clear the search box or switch back to the All tab.</span>
      </div>`;
    return;
  }

  host.innerHTML = sections.map(renderSection).join('');
}

function renderSection(section) {
  const n = section.questions.length;
  return `
    <section class="lc-section" style="margin-bottom:16px;">
      <div class="lc-section-title">
        <span>${escapeHtml(section.text || 'General')}</span>
        <span class="lc-section-count">${n} question${n === 1 ? '' : 's'}</span>
      </div>
      ${section.questions.map(renderQuestion).join('')}
    </section>
  `;
}

const TYPE_LABEL = {
  radio: 'Single choice',
  checkbox: 'Multiple choice',
  select: 'Dropdown',
  text: 'Text',
  textarea: 'Long text',
};

function renderQuestion(q) {
  const cols = columnsFor(q);
  const currentSet = toSelectedSet(q.currentAnswer);
  const stateCls = q.matchesCurrent ? 'is-match' : 'is-diff';
  const pill = q.matchesCurrent
    ? '<span class="pill pill-match">Matches</span>'
    : '<span class="pill pill-diff">Different</span>';
  const agreeChip = passesAgree(q)
    ? '<span class="pill pill-match">Sources agree</span>'
    : '';

  const body = cols.map((col) => `
    <div class="lc-col lc-col--${escapeHtml(col.kind)}">
      <div class="lc-col-head"><span class="lc-col-dot"></span>${escapeHtml(col.title)}</div>
      ${renderControl(q, col, currentSet)}
      <div class="lc-col-helper">${escapeHtml(col.helper)}</div>
    </div>
  `).join('');

  // Label column left, control area right - the layout LC360 itself uses
  // (a right-aligned bold question against its control). The control area
  // is where this page departs from the site: one column per answer source
  // instead of the single live control.
  return `
    <article class="lc-question ${stateCls}" data-uid="${escapeHtml(q.uid || '')}">
      <div class="lc-q-row">
        <div class="lc-q-labelcol">
          ${q.subheader ? `<div class="lc-q-sub">${escapeHtml(q.subheader)}</div>` : ''}
          <div class="lc-q-label">${escapeHtml(q.questionText || '(no label)')}</div>
          <div class="lc-q-badges">
            <span class="lc-q-type">${escapeHtml(TYPE_LABEL[q.inputType] || q.inputType || 'Text')}</span>
            ${agreeChip}${pill}
          </div>
        </div>
        <div class="lc-columns cols-${cols.length}">${body}</div>
      </div>
      ${renderRefs(q)}
    </article>
  `;
}

/**
 * Draw one column's control. Choice controls reuse the page's own option
 * ORDER so all three columns line up row for row - that alignment is the
 * whole point of the layout, and sorting by selection would destroy it.
 */
function renderControl(q, col, currentSet) {
  if (isChoice(q.inputType)) return renderChoiceControl(q, col, currentSet);
  return renderFieldControl(q, col);
}

function renderChoiceControl(q, col, currentSet) {
  const isCurrent = col.kind === 'current';
  const selected = toSelectedSet(col.value);
  const markCls = q.inputType === 'checkbox' ? 'lc-mark--check' : 'lc-mark--radio';

  const options = Array.isArray(q.options) ? q.options : [];
  const known = new Set(options.map((o) => keyOf(o.label)));

  const rows = options.map((opt) => {
    const k = keyOf(opt.label);
    const on = selected.has(k);
    let cls = 'lc-option' + (on ? ' is-on' : '');
    // Diff marks belong only on the suggestion columns - "changed relative
    // to the current value" is meaningless on the current value itself.
    if (!isCurrent) {
      if (on && !currentSet.has(k)) cls += ' is-added';
      else if (!on && currentSet.has(k)) cls += ' is-removed';
    }
    return optionRow(cls, markCls, opt.label, false);
  });

  // An answer the backend returned that is not one of the control's own
  // options. Rare, but it must be visible rather than silently dropped:
  // it means the suggestion cannot be applied as-is.
  const extras = [];
  labelsOf(col.value).forEach((label, k) => {
    if (!known.has(k)) extras.push(optionRow('lc-option is-on is-added', markCls, label, true));
  });

  if (rows.length === 0 && extras.length === 0) {
    return '<div class="lc-field is-empty">No answer</div>';
  }
  return `<div class="lc-options">${rows.join('')}${extras.join('')}</div>`;
}

function optionRow(cls, markCls, label, offList) {
  return `
    <div class="${cls}">
      <span class="lc-mark ${markCls}" aria-hidden="true"><span class="lc-mark-fill"></span></span>
      <span class="lc-option-label">${escapeHtml(label)}${offList ? '<span class="lc-offlist">not an option</span>' : ''}</span>
    </div>
  `;
}

function renderFieldControl(q, col) {
  const isCurrent = col.kind === 'current';
  const text = formatAnswer(col.value);
  const changed = !isCurrent && keyOf(text) !== keyOf(formatAnswer(q.currentAnswer));

  let cls = 'lc-field';
  if (q.inputType === 'textarea') cls += ' lc-field--textarea';
  else if (q.inputType === 'select') cls += ' lc-field--select';
  if (!text) cls += ' is-empty';
  if (changed) cls += ' is-changed';

  return `<div class="${cls}">${text ? escapeHtml(text) : 'No answer'}</div>`;
}

function renderRefs(q) {
  const labels = (q.formPass && Array.isArray(q.formPass.sourceLabels)) ? q.formPass.sourceLabels : [];
  const photos = sourcePhotosOf(q);
  if (labels.length === 0 && photos.length === 0) return '';

  const chips = labels.map((l) =>
    `<span class="lc-ref"><span class="lc-ref-key">Page</span>${escapeHtml(l)}</span>`
  ).join('');

  const chipRow = chips ? `<div class="lc-refs">${chips}</div>` : '';
  return chipRow + renderPhotoRefs(photos);
}

/**
 * The evidence photos as a disclosure.
 *
 * <details> rather than a click handler and a class toggle: the open/closed
 * state, the arrow, the keyboard behaviour and the accessible name all come
 * free and correct, and - the reason that matters here - `details[open]` is
 * something the print stylesheet can force, so every link lands in the
 * exported PDF whether or not the reader expanded the row on screen.
 *
 * Each row is a real <a href> to the LC360 photo handler, so it is
 * copy-pasteable, opens in a new tab, and survives the PDF export as a live
 * hyperlink. The full URL is printed under the thumbnail as text as well,
 * because a PDF that gets printed on paper loses the href and the URL is
 * then the only way back to the image.
 */
function renderPhotoRefs(photos) {
  if (!photos.length) return '';

  const rows = photos.map((p, i) => `
    <li class="lc-photo">
      <a class="lc-photo-link" href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer">
        <img class="lc-photo-thumb" src="${escapeHtml(p.thumbUrl || p.url)}"
             alt="Source image ${i + 1}" loading="lazy" />
        <span class="lc-photo-text">
          <span class="lc-photo-name">Source image ${i + 1}</span>
          <span class="lc-photo-url">${escapeHtml(p.url)}</span>
        </span>
      </a>
    </li>
  `).join('');

  const n = photos.length;
  return `
    <details class="lc-photos">
      <summary class="lc-photos-summary">
        <span class="lc-ref-key">Photos</span>
        <span class="lc-photos-count">${n} source image${n === 1 ? '' : 's'}</span>
        <span class="lc-photos-hint" aria-hidden="true"></span>
      </summary>
      <ul class="lc-photos-list">${rows}</ul>
    </details>
  `;
}

/**
 * Evidence photos for a question, as { id, url, thumbUrl }.
 *
 * The side panel omits any photo it could not build a URL for (no caseID on
 * the page URL), so an unlinkable photo never reaches here - which is why
 * this can filter on `url` and let the Photos row disappear entirely rather
 * than rendering a count that expands to dead rows.
 */
function sourcePhotosOf(q) {
  const photos = q.imagePass && q.imagePass.sourcePhotos;
  return Array.isArray(photos) ? photos.filter((p) => p && p.url) : [];
}

// ─────────────────────────────────────────────────────────────────────
// 6  Toolbar
// ─────────────────────────────────────────────────────────────────────

function wireToolbar() {
  const search = document.getElementById('cSearch');
  if (search) {
    search.addEventListener('input', () => {
      view.search = search.value;
      renderSections();
    });
  }

  document.querySelectorAll('#cFilter .tb-seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      view.filter = btn.dataset.filter;
      document.querySelectorAll('#cFilter .tb-seg-btn').forEach((b) => {
        const active = b === btn;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      renderSections();
    });
  });
}


// ─────────────────────────────────────────────────────────────────────
// 7  Export
// ─────────────────────────────────────────────────────────────────────
//
// One button, one output: a PDF, produced by the browser's own print
// pipeline with "Save as PDF" as the destination.
//
// This replaced a Word export that was not really a Word export. That code
// built an HTML string, typed the Blob `application/msword` and named the
// file .doc - a format Word will usually open, but which is HTML underneath
// and which any other handler (WordPad, a browser, a PDF viewer, Google
// Docs) shows as raw markup, `<!--[if gte mso 9]><xml>` block and all.
// Producing a real .docx would mean hand-writing a ZIP container and OOXML
// parts, because the extension CSP blocks loading a library from a CDN.
// Printing to PDF needs none of that, renders exactly what the reader sees,
// and keeps the <a href> links on the source photos live in the output.
//
// What the print stylesheet in compare.html contributes: it hides the
// chrome, forces the light palette, restores the column grid that the
// viewport breakpoints would otherwise collapse, and opens every photo
// disclosure so the links are in the PDF whether or not they were expanded
// on screen.

function wireExport() {
  const exportBtn = document.getElementById('btnExport');
  if (exportBtn) exportBtn.addEventListener('click', exportPdf);

  // Bound to the window events rather than called from exportPdf(), so
  // Ctrl+P and the browser menu produce the same document as the button.
  //
  // A closed <details> is hidden by the user agent through
  // ::details-content, which a print stylesheet cannot reach - so the
  // attribute has to be set for real and put back afterwards. Only the
  // ones we opened are re-closed, so a row the reader had expanded stays
  // expanded once the dialog is dismissed.
  let openedForPrint = [];

  window.addEventListener('beforeprint', () => {
    openedForPrint = Array.from(document.querySelectorAll('.lc-photos:not([open])'));
    openedForPrint.forEach((d) => { d.open = true; });
  });

  window.addEventListener('afterprint', () => {
    openedForPrint.forEach((d) => { d.open = false; });
    openedForPrint = [];
  });
}

/**
 * Print the report, scoped to the CURRENT VIEW.
 *
 * Two things happen around the print() call, both of which have to be undone
 * afterwards:
 *
 *   · The document title becomes the export filename. Chrome seeds the
 *     "Save as" name from document.title, so this is the only way to get a
 *     meaningful filename out of a print-to-PDF without asking the user to
 *     retype it.
 *   · A scope line is written into the print-only header, so a PDF made
 *     while a filter or search was active says so on its face rather than
 *     silently looking like the whole survey.
 *
 * print() is synchronous - it returns once the dialog closes - so the
 * restore runs after the user has saved or cancelled either way. It is
 * still in a finally, because a print dialog that throws (headless, a
 * blocked pop-up) must not leave the page renamed.
 */
function exportPdf() {
  const previousTitle = document.title;
  const scopeEl = document.getElementById('cPrintScope');
  const stampEl = document.getElementById('cPrintStamp');

  if (scopeEl) scopeEl.textContent = scopeLine();
  if (stampEl) stampEl.textContent = 'Generated ' + formatTimestamp(view.meta.generatedAt);
  document.title = exportFilename();

  try {
    window.print();
  } finally {
    document.title = previousTitle;
  }
}

/** "All 84 questions" / "12 of 84 questions (filter: different, search: "roof")". */
function scopeLine() {
  const shown = visibleSections().reduce((n, s) => n + s.questions.length, 0);
  const total = allQuestions().length;

  const notes = [];
  if (view.filter !== 'all') notes.push(`filter: ${view.filter}`);
  if (view.search.trim()) notes.push(`search: "${view.search.trim()}"`);

  if (shown === total && notes.length === 0) {
    return `All ${total} question${total === 1 ? '' : 's'}`;
  }
  return `${shown} of ${total} questions (${notes.join(', ')})`;
}

/**
 * Seeds the Save-as-PDF filename. No extension: Chrome appends .pdf itself,
 * and a literal ".pdf" here comes back as "….pdf.pdf".
 */
function exportFilename() {
  const survey = view.meta.surveyNumber ? `-Survey-${view.meta.surveyNumber}` : '';
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `SmartFill-Answer-Comparison${survey}-${stamp}`;
}
