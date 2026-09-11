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
 *   "Export Word" serialises the CURRENT VIEW (search + filter applied) to
 *   a Word-readable .doc. Word's HTML support predates flexbox and grid, so
 *   the export is rebuilt on tables with inline styles rather than being a
 *   dump of the live DOM - see buildExportHtml().
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
});

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
  const photos = (q.imagePass && Array.isArray(q.imagePass.sourcePhotoIds)) ? q.imagePass.sourcePhotoIds : [];
  if (labels.length === 0 && photos.length === 0) return '';

  const chips = [];
  labels.forEach((l) => chips.push(
    `<span class="lc-ref"><span class="lc-ref-key">Page</span>${escapeHtml(l)}</span>`
  ));
  if (photos.length) {
    chips.push(
      `<span class="lc-ref"><span class="lc-ref-key">Photos</span>${photos.length} source image${photos.length === 1 ? '' : 's'}</span>`
    );
  }
  return `<div class="lc-refs">${chips.join('')}</div>`;
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

function wireExport() {
  const printBtn = document.getElementById('btnPrint');
  if (printBtn) printBtn.addEventListener('click', () => window.print());

  const exportBtn = document.getElementById('btnExport');
  if (exportBtn) exportBtn.addEventListener('click', downloadWordDoc);
}

/**
 * Word reads HTML, but its layout engine predates flexbox and CSS grid and
 * ignores both - a straight dump of the live DOM opens as one long
 * single-column list with every column stacked. So the export is rebuilt
 * on <table> with inline styles, which Word has always laid out correctly.
 *
 * The exported document is the CURRENT VIEW, not the whole payload: if the
 * reader filtered to Different and searched "sprinkler", that is what they
 * asked to hand over. The applied filters are stamped into the header so
 * the document says so on its face.
 */
function downloadWordDoc() {
  const html = buildExportHtml();
  // The BOM is what tells Word the bytes are UTF-8; without it the degree
  // signs and dashes in inspection labels open as mojibake.
  const blob = new Blob(['﻿', html], { type: 'application/msword' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = exportFilename();
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next frame - revoking synchronously can beat the
  // download off the mark in Chrome.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportFilename() {
  const survey = view.meta.surveyNumber ? `-Survey-${view.meta.surveyNumber}` : '';
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `SmartFill-Answer-Comparison${survey}-${stamp}.doc`;
}

// Inline style fragments. Word drops most of a <style> block's cascade, so
// everything that must survive is set per element.
// Colours mirror the live form: #e9e9e9 section band on a #ddd hairline,
// #555 bold question labels, #3e3f3a bold option labels, #99948b field
// rules. Arial rather than the site's Roboto - Word can be relied on for
// Arial on every machine, and it is the site's own next fallback.
const X = {
  // The background is stated rather than left to the viewer: Word always
  // paints a white page, but the same bytes opened in a browser inherit the
  // reader's dark theme and render dark text on dark ground.
  page: 'font-family:Arial,\'Helvetica Neue\',Helvetica,sans-serif;font-size:10pt;'
    + 'color:#3e3f3a;background:#ffffff;',
  h1: 'font-size:17pt;font-weight:bold;color:#1f2a44;margin:0 0 4pt;',
  sub: 'font-size:9.5pt;color:#6b7280;margin:0 0 14pt;',
  metaTable: 'width:100%;border-collapse:collapse;margin:0 0 16pt;border:1px solid #dddddd;',
  metaKey: 'padding:5pt 8pt;border:1px solid #dddddd;background:#f5f5f5;font-size:8.5pt;'
    + 'font-weight:bold;color:#555555;text-transform:uppercase;width:22%;',
  metaVal: 'padding:5pt 8pt;border:1px solid #dddddd;font-size:10pt;',
  section: 'background:#e9e9e9;border:1px solid #dddddd;color:#333333;font-size:11pt;'
    + 'font-weight:bold;padding:5pt 8pt;margin:14pt 0 6pt;',
  qTable: 'width:100%;border-collapse:collapse;border:1px solid #dddddd;margin:0 0 8pt;',
  qHead: 'padding:6pt 9pt;border:1px solid #dddddd;background:#f5f5f5;',
  qLabel: 'font-size:10.5pt;font-weight:bold;color:#555555;',
  qSub: 'font-size:8pt;font-weight:bold;color:#989eb8;text-transform:uppercase;',
  qType: 'font-size:8.5pt;color:#6b7280;',
  colHead: 'padding:4pt 9pt;border:1px solid #dddddd;background:#fafafa;'
    + 'font-size:8.5pt;font-weight:bold;color:#5a6079;text-transform:uppercase;',
  colCell: 'padding:6pt 9pt;border:1px solid #dddddd;vertical-align:top;font-size:10pt;',
  helper: 'font-size:8pt;color:#989eb8;padding-top:4pt;',
  refCell: 'padding:4pt 9pt;border:1px solid #dddddd;background:#f5f5f5;font-size:8.5pt;color:#5a6079;',
  optOn: 'background:#e8f1fa;font-weight:bold;',
  optAdded: 'background:#d9f7ec;',
  optRemoved: 'background:#fde3e3;text-decoration:line-through;',
  fieldChanged: 'background:#fdf0d2;',
  empty: 'color:#909090;font-style:italic;',
};

function buildExportHtml() {
  const sections = visibleSections();
  const shown = sections.reduce((n, s) => n + s.questions.length, 0);
  const total = allQuestions().length;

  const filterNote = [];
  if (view.filter !== 'all') filterNote.push(`filter: ${view.filter}`);
  if (view.search.trim()) filterNote.push(`search: "${view.search.trim()}"`);
  const scope = shown === total
    ? `All ${total} question${total === 1 ? '' : 's'}`
    : `${shown} of ${total} questions (${filterNote.join(', ')})`;

  const m = view.meta;
  const metaRows = [
    ['Form', m.formName || '-'],
    ['Survey number', m.surveyNumber || '-'],
    ['Survey type', m.surveyType || '-'],
    ['Location', m.address || '-'],
    ['Result ID', m.resultId || '-'],
    ['Generated', formatTimestamp(m.generatedAt)],
    ['Scope', scope],
  ].map(([k, v]) => `<tr><td style="${X.metaKey}">${escapeHtml(k)}</td>`
    + `<td style="${X.metaVal}">${escapeHtml(v)}</td></tr>`).join('');

  const body = sections.map((s) => `
    <div style="${X.section}">${escapeHtml(s.text || 'General')}</div>
    ${s.questions.map(exportQuestion).join('')}
  `).join('');

  // The mso <xml> block sets Word's default view and page setup; landscape
  // because three answer columns do not fit a portrait A4 text column.
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8" />
<title>SmartFill Answer Comparison</title>
<!--[if gte mso 9]><xml>
  <w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument>
</xml><![endif]-->
<style>
  @page { size: 29.7cm 21cm; mso-page-orientation: landscape; margin: 1.2cm; }
  body { ${X.page} }
  table { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
</style>
</head>
<body style="${X.page}">
  <div style="${X.h1}">SmartFill — Answer Comparison</div>
  <div style="${X.sub}">Current form value versus the AI suggestions, question by question.</div>
  <table style="${X.metaTable}"><tbody>${metaRows}</tbody></table>
  ${body || '<p style="' + X.empty + '">No questions matched the current view.</p>'}
</body>
</html>`;
}

function exportQuestion(q) {
  const cols = columnsFor(q);
  const currentSet = toSelectedSet(q.currentAnswer);
  const width = Math.floor(100 / cols.length);
  const status = q.matchesCurrent ? 'MATCHES' : 'DIFFERENT';

  const headRow = cols.map((c) =>
    `<td style="${X.colHead}" width="${width}%">${escapeHtml(c.title)}</td>`).join('');

  const bodyRow = cols.map((c) => `
    <td style="${X.colCell}" width="${width}%">
      ${exportControl(q, c, currentSet)}
      <div style="${X.helper}">${escapeHtml(c.helper)}</div>
    </td>`).join('');

  const refs = exportRefs(q);

  return `
    <table style="${X.qTable}"><tbody>
      <tr><td style="${X.qHead}" colspan="${cols.length}">
        ${q.subheader ? `<div style="${X.qSub}">${escapeHtml(q.subheader)}</div>` : ''}
        <div style="${X.qLabel}">${escapeHtml(q.questionText || '(no label)')}</div>
        <div style="${X.qType}">${escapeHtml(TYPE_LABEL[q.inputType] || q.inputType || 'Text')} &middot; ${status}</div>
      </td></tr>
      <tr>${headRow}</tr>
      <tr>${bodyRow}</tr>
      ${refs ? `<tr><td style="${X.refCell}" colspan="${cols.length}">${refs}</td></tr>` : ''}
    </tbody></table>`;
}

/**
 * Word has no reliable way to draw an unchecked radio through CSS, so the
 * export swaps the drawn glyphs for the Unicode ones Word renders natively
 * in its default fonts. Same information, no font dependency beyond what
 * Word already ships.
 */
function exportControl(q, col, currentSet) {
  if (!isChoice(q.inputType)) {
    const text = formatAnswer(col.value);
    const changed = col.kind !== 'current'
      && keyOf(text) !== keyOf(formatAnswer(q.currentAnswer));
    const style = changed ? X.fieldChanged : '';
    if (!text) return `<div style="${X.empty}">No answer</div>`;
    return `<div style="${style}white-space:pre-wrap;">${escapeHtml(text)}</div>`;
  }

  const isCurrent = col.kind === 'current';
  const selected = toSelectedSet(col.value);
  const on = q.inputType === 'checkbox' ? '&#9745;' : '&#9679;';   // ☑ / ●
  const off = q.inputType === 'checkbox' ? '&#9744;' : '&#9675;';  // ☐ / ○

  const options = Array.isArray(q.options) ? q.options : [];
  const known = new Set(options.map((o) => keyOf(o.label)));

  const rows = options.map((opt) => {
    const k = keyOf(opt.label);
    const picked = selected.has(k);
    let style = picked ? X.optOn : '';
    if (!isCurrent) {
      if (picked && !currentSet.has(k)) style = X.optOn + X.optAdded;
      else if (!picked && currentSet.has(k)) style = X.optRemoved;
    }
    return `<div style="${style}padding:1pt 3pt;">${picked ? on : off} ${escapeHtml(opt.label)}</div>`;
  });

  const extras = [];
  labelsOf(col.value).forEach((label, k) => {
    if (!known.has(k)) {
      extras.push(`<div style="${X.optOn}${X.optAdded}padding:1pt 3pt;">`
        + `${on} ${escapeHtml(label)} <i>(not an option)</i></div>`);
    }
  });

  if (rows.length === 0 && extras.length === 0) return `<div style="${X.empty}">No answer</div>`;
  return rows.join('') + extras.join('');
}

function exportRefs(q) {
  const labels = (q.formPass && Array.isArray(q.formPass.sourceLabels)) ? q.formPass.sourceLabels : [];
  const photos = (q.imagePass && Array.isArray(q.imagePass.sourcePhotoIds)) ? q.imagePass.sourcePhotoIds : [];
  const bits = [];
  if (labels.length) bits.push('Pages consulted: ' + labels.map((l) => escapeHtml(l)).join(', '));
  if (photos.length) bits.push(`Source images: ${photos.length}`);
  return bits.join(' &nbsp;·&nbsp; ');
}
