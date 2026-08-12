/**
 * sidepanel/sidepanel.js - Controller for the NSR-Boost side-panel UI.
 *
 * The side panel has three rail tabs: Sync (primary), Activity, Config.
 * The Sync tab hosts TWO sub-modes - form review and Order Photos - and
 * picks the right one based on which capability the active page exposes:
 *
 *   Page kind                                       → default mode  · mode strip?
 *   ───────────────────────────────────────────────────────────────────────────
 *   Supported NSR form (e.g. WKFC Cover)            → form          · hidden
 *   LC360 "Order Photos" page                       → images        · hidden
 *   Both at once (rare; an NSR form with #sortable) → form          · visible
 *   Neither                                         → form (warning)· hidden
 *
 * Workflows handled here:
 *   Form review:    SCRAPE_AND_VERIFY → buildEntries → Accept/Reject/
 *                   Reconsider → APPLY_ANSWER / REVERT_ANSWER /
 *                   FOCUS_QUESTION.
 *   Order Photos:   EXTRACT_IMAGES → render gallery → (search/filter) →
 *                   Display Description → FETCH_IMAGE_BLOB x N →
 *                   direct POST to IMAGES_API (multipart FormData) →
 *                   chrome.tabs.create on the results page.
 *                   Sort toggle: APPLY_API_RESULTS / RESTORE_IMAGES.
 *
 * Both flows share: Activity log, toast, footer status dot, detection card,
 * Config tab. Everything below is in a single IIFE-free module so the
 * mode-switch can directly call into either subsystem.
 */

'use strict';

// ═════════════════════════════════════════════════════════════════════
// 1. DOM cache
// ═════════════════════════════════════════════════════════════════════

const $ = (id) => document.getElementById(id);

const els = {
  // Detection (universal)
  detectionCard: $('detection-card'),
  detectionLabel: $('detection-label'),
  detectionName: $('detection-name'),
  detectionBadge: $('detection-badge'),
  detectionUrl: $('detection-url'),
  detectionSurveyType: $('detection-surveytype'),
  detectionSurveyTypeBlk: $('detection-surveytype-block'),
  detectionAddressBlock: $('detection-address-block'),
  detectionAddress: $('detection-address'),
  btnCopyAddress: $('btn-copy-address'),
  btnOpenAddress: $('btn-open-address'),
  btnMapAddress: $('btn-map-address'),

  // Mode strip
  modeStrip: $('mode-strip'),
  modePanelForm: document.querySelector('.mode-panel[data-mode-panel="form"]'),
  modePanelImages: document.querySelector('.mode-panel[data-mode-panel="images"]'),

  // ── Form-review subpanel ────────────────────────────────────────
  statusBadge: $('status-badge'),
  statusDesc: $('status-desc'),
  canvasTitle: $('canvas-title'),
  canvasSubtitle: $('canvas-subtitle'),
  canvasRing: $('canvas-ring'),
  ringProgress: $('ring-progress'),
  canvasProgressLabel: $('canvas-progress-label'),
  btnSync: $('btn-sync'),

  queueCard: $('queue-card'),
  queueHeading: $('queue-heading'),
  countPending: $('count-pending'),
  countAccepted: $('count-accepted'),
  countRejected: $('count-rejected'),
  btnRejectAll: $('btn-reject-all'),
  btnAcceptAll: $('btn-accept-all'),
  btnRefresh: $('btn-refresh'),
  suggestionList: $('suggestion-list'),
  btnSendFeedback: $('btn-send-feedback'),

  warningCard: $('warning-card'),
  warningBody: $('warning-body'),
  supportedList: $('supported-list'),

  filterCountAll: $('filter-count-all'),
  filterCountDifferent: $('filter-count-different'),
  filterCountMatched: $('filter-count-matched'),

  // ── Images subpanel ─────────────────────────────────────────────

  imgToolbarCard: $('img-toolbar-card'),
  imgSearch: $('img-search'),
  imgCount: $('img-count'),
  btnSortOrig: $('btn-sort-original'),
  btnSortApi: $('btn-sort-api'),

  imgProgressCard: $('img-progress-card'),
  imgProgressLabel: $('img-progress-label'),
  imgProgressCount: $('img-progress-count'),
  imgProgressBar: $('img-progress-bar'),
  imgProgressDetail: $('img-progress-detail'),

  imgGalleryCard: $('img-gallery-card'),
  imgGallery: $('img-gallery'),

  imgFooter: $('img-footer'),
  btnDescribe: $('btn-img-describe'),

  imgStatusCard: $('img-status-card'),
  imgStatusTitle: $('img-status-title'),
  imgStatusBody: $('img-status-body'),

  // ── Shared chrome ───────────────────────────────────────────────
  activityList: $('activity-list'),
  btnClearLog: $('btn-clear-log'),
  connDot: $('conn-dot'),
  connText: $('conn-text'),
  toast: $('toast'),

  // Config: color pickers
  cfgDark: $('cfg-dark'),
  cfgColorForm: $('cfg-color-form'),
  cfgColorImage: $('cfg-color-image'),
  cfgColorCurrent: $('cfg-color-current'),
  swatchForm: $('swatch-form'),
  swatchImage: $('swatch-image'),
  swatchCurrent: $('swatch-current'),
};

// ═════════════════════════════════════════════════════════════════════
// 2. State
// ═════════════════════════════════════════════════════════════════════

const state = {
  // Combined detection { form, images, url, title, hostname }
  detection: null,
  // Which subpanel is showing
  mode: 'form',           // 'form' | 'images'

  // Form-review state
  pipeline: 'idle',       // 'idle' | 'scraping' | 'uploading' | 'analyzing' | 'complete' | 'error'
  entries: [],
  apiByQuestionId: {},
  apiStartMs: 0,
  filter: 'all',          // 'all' | 'different' | 'matched'
  // result_id returned by the verify API. Used to tie the feedback POST
  // back to the original AI run. Empty when no Sync has completed.
  resultId: '',
  // Survey number from the last pipeline run. Used for usage attribution so
  // every event can be joined back to survey_results / token_usage_log.
  surveyNumber: '',
  feedbackSending: false,
  // caseID captured at pipeline-start, when state.detection.url is still the
  // LC360 form page. Source-photo reference links are built from this stable
  // value rather than the live state.detection.url, which gets overwritten by
  // every PAGE_DETECTED broadcast (tab switch / SPA navigation) and would
  // otherwise make the photo links vanish on the next card repaint.
  caseId: '',
  // Reference-photo thumbnail cache, keyed by the photoHandler URL → a data
  // URL fetched (with session cookies) via the content script. Populated only
  // when the direct cross-origin <img> load fails; lets re-renders (filter
  // changes, single-card repaints) reuse the bytes instead of re-fetching.
  refThumbCache: {},
  // URL of the page the current pipeline output (queue / saved / error
  // banner) belongs to. Used to clear that output when the side panel moves
  // to a different page, so an error from page A never shows on page B.
  pipelinePageKey: null,
  // The tab the current pipeline output belongs to. Pinned at pipeline start
  // so the feedback path can re-scrape *that* tab for ground truth even after
  // the user has tabbed away (state.detection.tabId follows the active tab).
  pipelineTabId: null,
  // result_id whose feedback has already been delivered. Guards against the
  // auto-send safety net posting the same review a second time.
  feedbackSentForResultId: null,

  // Image-extraction state
  images: [],
  imgMeta: null,
  currentSort: 'original',
  apiResults: null,
  isImagesProcessing: false,
  imagesInitialised: false,    // first auto-extract has run
  // Per-image label choice after AI verification:
  //   labelChoice: { photoId → 'ai' | 'original' }   (persists across sorts)
  //   aiLabelById: { photoId → AI verifiedLabel }
  //   origLabelById: { photoId → original label at verify time }
  labelChoice: {},
  aiLabelById: {},
  origLabelById: {},

  // Speculative full-res blob prefetch (see startImgPrefetch). We download
  // blobs right after extract so clicking "Display Description" is instant.
  //   imgBlobCache:     photoId → { blob, filename }
  //   imgBlobInFlight:  photoId → Promise (dedupe concurrent fetches)
  //   imgBlobCacheBytes: retained size, capped at PREFETCH_BUDGET_BYTES
  //   imgPrefetchToken:  bumped to cancel a superseded prefetch run
  imgBlobCache: new Map(),
  imgBlobInFlight: new Map(),
  imgBlobCacheBytes: 0,
  imgPrefetchToken: 0,

  // Shared
  activity: [],
};

const STATUS_DESCRIPTIONS = {
  idle: 'Open a supported NSR form to begin.',
  ready: 'Ready to sync the current form.',
  scraping: 'Reading questions from the page…',
  uploading: 'Processing...',
  analyzing: 'Matching AI answers to questions…',
  complete: 'AI analysis complete. Review answers below.',
  error: 'Something went wrong - see details below.',
  unsupported: 'This page is not a supported NSR form.',
};

// ═════════════════════════════════════════════════════════════════════
// 3. Shared helpers
// ═════════════════════════════════════════════════════════════════════

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

const BOOST_ORIGIN = 'https://boostusa.losscontrol360.com';

/**
 * Extract the inspection GUID from a BoostUSA URL.
 *
 * BoostUSA puts it in the *path*, not a query param as NSR did with `caseID`:
 *   /Inspection/3955baf3-34e9-46f5-a8e2-99e87a679ecd
 *   /Inspection/Form/3955baf3-…?inspectionFormID=…&contextID=…
 *   /Inspection/AttachFiles/3955baf3-…
 *
 * Note `inspectionFormID` is per-inspection here, so it is NOT a stable form
 * identifier - do not key anything off it (see docs/PLATFORM-ANALYSIS.md §7).
 */
function extractCaseId(url) {
  if (!url) return '';
  const m = String(url).match(
    /\/Inspection\/(?:[A-Za-z]+\/)?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/
  );
  return m ? m[1] : '';
}

/**
 * Build the image URL for an (inspectionID, photoID) pair:
 *   /Inspection/Images/Image?inspectionID=<guid>&photoID=<guid>&size=<px>&version=1
 *
 * `size` is the max edge in pixels; omit it for the original. The page's own
 * thumbnails use size=150.
 *
 * Returns '' if either id is missing.
 */
function buildPhotoHandlerUrl(caseId, photoId, size) {
  if (!caseId || !photoId) return '';
  const params = [
    `inspectionID=${encodeURIComponent(caseId)}`,
    `photoID=${encodeURIComponent(photoId)}`,
  ];
  if (size) params.push(`size=${encodeURIComponent(size)}`);
  params.push('version=1');
  return `${BOOST_ORIGIN}/Inspection/Images/Image?${params.join('&')}`;
}

/**
 * Open an image gallery in the on-page modal (NOT a new tab). Shared by both
 * flows: the verify "source photo" links (gallery = that question's reference
 * photos) and the Order Photos thumbnails (gallery = all photos in on-page
 * order).
 *
 *   images - a URL string, or an array of URL strings (the gallery).
 *   index  - which image to open first (default 0).
 *
 * The modal is rendered by content/imageModal.js running on the LC360 page,
 * because that page is same-origin with photoHandler and carries the session
 * cookies the image needs. We dispatch to the currently active tab (same as
 * the form Accept/Reject actions). If that tab isn't the LC360 page, the
 * content script is unreachable and we surface a "wrong page" note.
 */
function openImageOnPage(images, index = 0) {
  const gallery = Array.isArray(images) ? images.filter(Boolean) : (images ? [images] : []);
  if (!gallery.length) return;
  chrome.runtime.sendMessage(
    { action: 'SHOW_IMAGE_MODAL', images: gallery, index },
    (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        showToast("You're not on the LC360 page - switch to the inspection tab to view the image.");
      }
    }
  );
}

function setConnection(stateName /* 'idle'|'online'|'error' */, text) {
  els.connDot.className = `conn-dot ${stateName === 'online' ? 'is-online' : stateName === 'error' ? 'is-error' : ''
    }`;
  els.connText.textContent = text;
}

function showToast(message, ms = 2200) {
  els.toast.textContent = message;
  els.toast.classList.add('is-visible');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => els.toast.classList.remove('is-visible'), ms);
}

function logActivity(message, level = 'info') {
  const ts = new Date();
  state.activity.unshift({ ts, message, level });
  if (state.activity.length > 200) state.activity.pop();
  renderActivity();
}

// ── Address actions (every inspection page) ─────────────────────────────
// Copy the detected inspection address / open it in Google search or Google
// Maps. These read only from state.detection.generalInfo and never affect the
// Sync flow.
//
// On NSR the address could only be scraped from General Information. BoostUSA
// carries it on the engine (inspectionInfo.locationAddress) so the block now
// appears on form pages too - see generalInfoBlock() in content/content.js.

function generalInfo() {
  return (state.detection && state.detection.generalInfo) || null;
}

function detectedAddress() {
  const gi = generalInfo();
  return (gi && gi.address) || '';
}

/**
 * The platform's own geocode for this risk, when the engine supplied it.
 * Returns null on General Information pages (scraped, no coordinates).
 */
function detectedLatLng() {
  const gi = generalInfo();
  if (!gi || gi.latitude == null || gi.longitude == null) return null;
  const lat = Number(gi.latitude);
  const lng = Number(gi.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

async function copyAddress() {
  const addr = detectedAddress();
  if (!addr) { showToast('No address detected'); return; }
  try {
    await navigator.clipboard.writeText(addr);
    showToast('Address copied');
    logActivity('Address copied to clipboard', 'success');
  } catch (e) {
    showToast('Copy failed: ' + e.message);
  }
}

// Open a URL in a new tab placed immediately to the right of the active tab,
// in the side panel's own window (same pattern as openResultsTab).
async function openUrlBesideTab(url, logLabel) {
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    const createOpts = { url, active: true };
    if (active && typeof active.index === 'number') {
      createOpts.index = active.index + 1;
      createOpts.openerTabId = active.id;
    }
    if (active && typeof active.windowId === 'number') {
      createOpts.windowId = active.windowId;
    }
    await chrome.tabs.create(createOpts);
    if (logLabel) logActivity(logLabel, 'info');
  } catch (e) {
    showToast('Could not open tab: ' + e.message);
  }
}

function openAddressInGoogle() {
  const addr = detectedAddress();
  if (!addr) { showToast('No address detected'); return; }
  openUrlBesideTab(
    'https://www.google.com/search?q=' + encodeURIComponent(addr),
    'Opened address in Google'
  );
}

/**
 * Open the risk location in Google Maps.
 *
 * Prefers the platform's own geocode when the engine supplied it: a text
 * search for something like "1290 Nostrand Avenue" can land on the wrong
 * match, whereas the coordinates pin the surveyed building exactly. Falls
 * back to the address string on General Information pages, which are scraped
 * and carry no coordinates.
 */
function openAddressInMaps() {
  const addr = detectedAddress();
  const coords = detectedLatLng();
  if (!addr && !coords) { showToast('No address detected'); return; }

  const query = coords ? `${coords.lat},${coords.lng}` : addr;
  openUrlBesideTab(
    'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(query),
    coords ? 'Opened location in Maps (geocoded)' : 'Opened address in Maps'
  );
}

if (els.btnCopyAddress) els.btnCopyAddress.addEventListener('click', copyAddress);
if (els.btnOpenAddress) els.btnOpenAddress.addEventListener('click', openAddressInGoogle);
if (els.btnMapAddress) els.btnMapAddress.addEventListener('click', openAddressInMaps);

// ═════════════════════════════════════════════════════════════════════
// 4. Tab navigation (rail)
// ═════════════════════════════════════════════════════════════════════

document.querySelectorAll('.rail-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const id = tab.dataset.tab;
    document.querySelectorAll('.rail-tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('is-active', p.dataset.panel === id);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════
// 5. Mode switching (form ↔ images inside the Sync tab)
// ═════════════════════════════════════════════════════════════════════

function setMode(mode, opts) {
  const { auto = false } = opts || {};
  if (state.mode === mode && !auto) return;
  state.mode = mode;

  els.modePanelForm.classList.toggle('is-active', mode === 'form');
  els.modePanelImages.classList.toggle('is-active', mode === 'images');

  document.querySelectorAll('.mode-btn').forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  // First time we enter images-mode on a supported page, auto-extract.
  if (mode === 'images' && state.detection?.images?.supported && !state.imagesInitialised) {
    state.imagesInitialised = true;
    extractImages();
  }
}

document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
});

// ═════════════════════════════════════════════════════════════════════
// 6. Detection rendering (top card) + mode auto-selection
// ═════════════════════════════════════════════════════════════════════

/**
 * Update the universal detection card AND decide which sub-mode the user
 * should land on. Rules:
 *   · Form supported AND images supported → both modes available, default
 *     to form, show the mode strip.
 *   · Form supported only → form mode, no strip.
 *   · Images supported only → images mode, no strip.
 *   · Neither → form mode, no strip (the form subpanel will show the
 *     "Unsupported page" warning).
 */
function renderDetection() {
  const d = state.detection;
  if (!d) {
    els.detectionLabel.textContent = 'Detected Page';
    els.detectionName.textContent = 'Checking…';
    els.detectionBadge.textContent = 'DETECTING';
    els.detectionBadge.className = 'badge badge-idle';
    return;
  }

  const formOk = !!d.form?.supported;
  const imagesOk = !!d.images?.supported;

  // ── Decide which mode to show ────────────────────────────────────
  // If the user is actively in a mode, don't yank them out unless the
  // current mode lost its capability.
  let nextMode = state.mode;
  if (formOk && imagesOk) {
    els.modeStrip.style.display = 'flex';
    // Keep whichever mode they're on; if it's the very first detection,
    // default to form.
    if (!state.detection?.__seen) nextMode = 'form';
  } else if (formOk) {
    els.modeStrip.style.display = 'none';
    nextMode = 'form';
  } else if (imagesOk) {
    els.modeStrip.style.display = 'none';
    nextMode = 'images';
  } else {
    els.modeStrip.style.display = 'none';
    nextMode = 'form';
  }
  // Reset images-auto-extract flag when leaving an images-supported page,
  // so a future return triggers a fresh extract.
  if (!imagesOk) state.imagesInitialised = false;

  setMode(nextMode, { auto: true });

  // ── Render the detection-card content based on the active mode ───
  if (state.mode === 'form') {
    renderFormDetection(d);
  } else {
    renderImagesDetection(d);
  }

  // Address block is universal: it shows on every General Information page
  // (any case type), independent of the mode-specific render above and of
  // whether the page is a supported Sync target.
  renderAddressBlock(d);

  // Mark that we've rendered once so the next PAGE_DETECTED doesn't
  // override the user's manual mode selection.
  d.__seen = true;
}

/**
 * Show the property-address block whenever detection scraped an inspection
 * address (i.e. on any General Information page). Purely informational - it
 * never touches the Sync button's enabled/disabled state, which is decided by
 * the registry match in renderFormDetection().
 */
function renderAddressBlock(d) {
  if (!els.detectionAddressBlock || !els.detectionAddress) return;
  const addr = (d && d.generalInfo && d.generalInfo.address) || '';
  if (addr) {
    els.detectionAddress.textContent = addr;
    els.detectionAddressBlock.style.display = 'block';
  } else {
    els.detectionAddressBlock.style.display = 'none';
  }
}

function renderSurveyType(d) {
  if (!els.detectionSurveyTypeBlk || !els.detectionSurveyType) return;
  // Prefer the detection root's caseTypeName (set by content.js); fall back
  // to the form record or the images metadata.
  const st =
    (d && d.caseTypeName) ||
    (d && d.form && d.form.caseTypeName) ||
    (d && d.images && d.images.meta && d.images.meta.surveyType) ||
    '';
  els.detectionSurveyType.textContent = st || '-';
  els.detectionSurveyTypeBlk.style.display = 'block';
}

function renderFormDetection(d) {
  const f = d.form;
  els.detectionLabel.textContent = 'Detected Form';

  if (f?.supported) {
    els.detectionName.textContent = f.form.name;
    els.detectionBadge.textContent = 'SUPPORTED';
    els.detectionBadge.className = 'badge badge-success';
    els.warningCard.style.display = 'none';
    els.btnSync.disabled = false;
    setStatusBadge('READY', 'idle');
    // Button label + ready copy depend on which backend flow this form uses.
    // verify         → "Sync & Verify with AI" (Core Revised, unchanged)
    // knowledge_base → "Save to SmartFill" (Cover, General Information)
    setSyncButtonForFlow(f.form.flow || 'verify');
  } else {
    els.detectionName.textContent = 'Unsupported page';
    els.detectionBadge.textContent = 'NOT SUPPORTED';
    els.detectionBadge.className = 'badge badge-warning';
    renderSupportedList(d);
    els.warningCard.style.display = 'block';

    // Surface the detected case type alongside the header so the inspector
    // can tell *why* a page is unsupported: a header we don't know vs. a
    // known header gated out by the page's case type.
    const ctName = (d && d.caseTypeName)
      || (f && f.caseTypeName)
      || '';
    const ctSuffix = ctName ? ` (case type: "${ctName}")` : '';

    let body;
    if (f?.reason === 'Unsupported form' && f.detectedHeader) {
      body = `Detected form header: "${f.detectedHeader}"${ctSuffix} - this is not in the supported list for this case type.`;
    } else if (f?.reason === 'Form header not found on page') {
      body = 'No form header (.mainSectionHeaderLabel) was found. Make sure the form is fully loaded.';
    } else {
      body = `The current tab is not a recognized NSR form page (${f?.reason || 'unknown'})${ctSuffix}.`;
    }
    els.warningBody.textContent = body;
    els.btnSync.disabled = true;
    setStatusBadge('UNSUPPORTED', 'warning');
    els.statusDesc.textContent = STATUS_DESCRIPTIONS.unsupported;
    // Reset to default verify label so the next supported page starts clean.
    setSyncButtonForFlow('verify');
  }

  renderSurveyType(d);
}

/**
 * Update the sync button's visible label and the canvas "Ready" copy to
 * match the flow the active form uses. The button still fires the same
 * `startPipeline()` handler - only the wording changes.
 */
function setSyncButtonForFlow(flow) {
  const labelSpan = els.btnSync.querySelector('span');
  if (flow === 'knowledge_base') {
    if (labelSpan) labelSpan.textContent = 'Save to SmartFill';
    els.statusDesc.textContent = 'Ready to save this page to SmartFill.';
  } else {
    // 'verify' and 'kb_then_verify' both use the single "Sync & Verify with
    // AI" button. For kb_then_verify that one click fires both the cover
    // (knowledge_base) save and the verify pass in sequence.
    if (labelSpan) labelSpan.textContent = 'Sync & Verify with AI';
    els.statusDesc.textContent = STATUS_DESCRIPTIONS.ready;
  }
}

function renderImagesDetection(d) {
  const im = d.images;
  els.detectionLabel.textContent = 'Detected Page';

  if (im?.supported) {
    const count = im.count ?? '?';
    els.detectionName.textContent = `Order Photos · ${count} image${count === 1 ? '' : 's'}`;
    els.detectionBadge.textContent = 'SUPPORTED';
    els.detectionBadge.className = 'badge badge-success';
    els.imgStatusCard.style.display = 'none';
  } else {
    els.detectionName.textContent = 'Order Photos panel not open';
    els.detectionBadge.textContent = 'NOT SUPPORTED';
    els.detectionBadge.className = 'badge badge-warning';
    hidePhotoUi();
    showImgStatusWarning(
      'Order Photos panel not open',
      'Click <strong>ORDER</strong> above the photo rail to open the '
      + '<strong>Order/Edit Photos</strong> panel.'
    );
  }

  renderSurveyType(d);
}

// Human-readable flow descriptions for the supported-forms list. Keeps the
// UI copy in one place instead of scattering strings through the renderer.
const FLOW_LABELS = {
  verify: 'AI review (Accept / Reject queue)',
  knowledge_base: 'Save to SmartFill',
  kb_then_verify: 'Save to SmartFill, then AI review',
};

/**
 * Render the "Supported forms" list inside the Unsupported-page warning.
 *
 * Registry-driven: reads window.NSR_FORMS.SUPPORTED_FORMS so the list always
 * matches what the extension can actually detect - add a form to the registry
 * and it shows up here automatically, no second edit needed.
 *
 * Case-type-aware: the LC360 page carries a `Utilant.CaseTypeName`. When we
 * know it (passed in via `detection`), each form is tagged as either
 * applicable to THIS page's case type ("on this page") or belonging to a
 * different case type ("other case type"), so the inspector can see at a
 * glance why the current page isn't matching.
 *
 * @param {object} [detection] - the current page detection blob. Optional;
 *        when omitted (cold start) the full registry is shown ungrouped.
 */
function renderSupportedList(detection) {
  if (!els.supportedList) return;
  els.supportedList.innerHTML = '';

  const FORMS = (typeof window !== 'undefined' && window.NSR_FORMS) || null;

  // Fallback: registry not loaded (shouldn't happen now that forms.js is
  // included before sidepanel.js, but keep the panel functional regardless).
  if (!FORMS || !Array.isArray(FORMS.SUPPORTED_FORMS)) {
    [
      'WKFC Cover',
      'WKFC: Core Revised',
      'General Information',
      'Dual: Habitational Property Form',
    ].forEach((name) => {
      const li = document.createElement('li');
      li.textContent = name;
      els.supportedList.appendChild(li);
    });
    return;
  }

  // The case type the current page reports, if any. Empty string when it
  // couldn't be scraped (older page, or Utilant.CaseTypeName missing).
  const currentCaseType =
    (detection && detection.caseTypeName)
    || (detection && detection.form && detection.form.caseTypeName)
    || (detection && detection.images && detection.images.meta && detection.images.meta.surveyType)
    || '';
  const currentCt = currentCaseType.replace(/\s+/g, ' ').trim();

  // The form header the page actually rendered (drives "matched here").
  const detectedHeader =
    (detection && detection.form && detection.form.detectedHeader) || '';
  const detectedHeaderLc = detectedHeader.replace(/\s+/g, ' ').trim().toLowerCase();

  // Group the registry by case type. A form with no `caseTypes` array is
  // universal; we label it "Any case type".
  const groups = new Map(); // caseTypeLabel -> [forms]
  const UNIVERSAL = 'Any case type';
  FORMS.SUPPORTED_FORMS.forEach((form) => {
    const cts = Array.isArray(form.caseTypes) && form.caseTypes.length
      ? form.caseTypes
      : [UNIVERSAL];
    cts.forEach((ct) => {
      if (!groups.has(ct)) groups.set(ct, []);
      groups.get(ct).push(form);
    });
  });

  // Order: the current page's case type first (so the relevant forms are at
  // the top), then the rest alphabetically, with universal forms last.
  const groupKeys = Array.from(groups.keys()).sort((a, b) => {
    if (currentCt && a === currentCt) return -1;
    if (currentCt && b === currentCt) return 1;
    if (a === UNIVERSAL) return 1;
    if (b === UNIVERSAL) return -1;
    return a.localeCompare(b);
  });

  groupKeys.forEach((ct) => {
    const applicableNow = !currentCt || ct === currentCt || ct === UNIVERSAL;

    // Group heading row (the case-type name + an applicability hint).
    const headLi = document.createElement('li');
    headLi.className = 'supported-group' + (applicableNow ? ' is-active' : '');
    const ctName = document.createElement('span');
    ctName.className = 'supported-group-name';
    ctName.textContent = ct;
    headLi.appendChild(ctName);
    if (currentCt) {
      const tag = document.createElement('span');
      tag.className = 'supported-group-tag ' + (applicableNow ? 'tag-here' : 'tag-other');
      tag.textContent = applicableNow ? 'this page' : 'other case type';
      headLi.appendChild(tag);
    }
    els.supportedList.appendChild(headLi);

    // Forms within the group.
    groups.get(ct).forEach((form) => {
      const li = document.createElement('li');
      li.className = 'supported-form';

      const nameWrap = document.createElement('span');
      nameWrap.className = 'supported-form-name';
      nameWrap.textContent = form.name || form.shortName || form.formId;

      // Mark the form that actually matched this page's header.
      const isMatchedHere =
        applicableNow &&
        detectedHeaderLc &&
        (form.titleHint || form.name || '').toLowerCase() &&
        detectedHeaderLc.includes((form.titleHint || form.name || '').toLowerCase());
      if (isMatchedHere) {
        li.classList.add('is-detected');
        const dot = document.createElement('span');
        dot.className = 'supported-form-match';
        dot.textContent = 'detected here';
        nameWrap.appendChild(dot);
      }

      const flowEl = document.createElement('span');
      flowEl.className = 'supported-form-flow';
      flowEl.textContent = FLOW_LABELS[form.flow] || form.flow || '';

      li.appendChild(nameWrap);
      li.appendChild(flowEl);
      els.supportedList.appendChild(li);
    });
  });

  // Footer note explaining the case-type gating, shown only when we know the
  // current case type (so the user understands the "other case type" tags).
  if (currentCt) {
    const note = document.createElement('li');
    note.className = 'supported-note';
    note.textContent =
      `This page reports case type "${currentCt}". Only forms for that case type ` +
      `(plus any-case-type forms) can be detected here.`;
    els.supportedList.appendChild(note);
  } else {
    const note = document.createElement('li');
    note.className = 'supported-note';
    note.textContent =
      'Case type could not be read from this page, so all forms are listed. ' +
      'If a form still shows unsupported, reload the page after the extension loads.';
    els.supportedList.appendChild(note);
  }
}

function requestDetection() {
  chrome.runtime.sendMessage({ action: 'REQUEST_DETECTION' }).catch(() => { });
}

// ═════════════════════════════════════════════════════════════════════
// 7. Message bus
// ═════════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'PAGE_DETECTED') {
    const newUrl = msg.url || '';
    const hasOutput = !!state.pipelinePageKey;
    const onOwnerPage = hasOutput && newUrl === state.pipelinePageKey;

    // Leaving the page that owns the current verify/KB output: blank the
    // display so a result/error from page A doesn't bleed onto page B - but
    // KEEP the data in memory (state.entries + the Accept/Reject decisions)
    // so it can be restored when we come back. (Destroying it here was the
    // regression: switching tabs wiped the review queue.)
    if (hasOutput && !onOwnerPage) {
      clearFormOutputDisplay();
    }

    // We keep msg.tabId on the detection blob so any later operation that
    // must talk to the LC360 page (image fetches, scrape, apply) can pin
    // the request to *that* tab even if the user has tabbed away.
    state.detection = msg.detection
      ? { ...msg.detection, url: msg.url, title: msg.title, tabId: msg.tabId }
      : null;
    renderDetection();

    // Back on the page that owns the output: re-show the stored review queue
    // with every Accept/Reject decision intact.
    if (onOwnerPage && state.entries.length) {
      restoreFormOutput();
    }
  }
  if (msg.action === 'PIPELINE_PROGRESS') {
    handleProgress(msg);
  }
});

// ═════════════════════════════════════════════════════════════════════
// 8. Form-review subsystem
// ═════════════════════════════════════════════════════════════════════

function setRingProgress(percent) {
  const clamped = Math.max(0, Math.min(100, percent));
  const circumference = 175.93; // 2π * 28
  els.ringProgress.style.strokeDashoffset = circumference * (1 - clamped / 100);
  els.canvasProgressLabel.textContent = `${Math.round(clamped)}% COMPLETED`;
}

function setRingSpinning(on) {
  els.canvasRing.classList.toggle('is-spinning', !!on);
}

function setStatusBadge(label, kind) {
  els.statusBadge.textContent = label;
  els.statusBadge.className = `badge badge-${kind || 'idle'}`;
}

els.btnSync.addEventListener('click', startPipeline);

function startPipeline() {
  if (!state.detection?.form?.supported) {
    showToast('This page is not a supported NSR form');
    return;
  }
  state.pipeline = 'scraping';
  state.entries = [];
  state.apiByQuestionId = {};
  state.resultId = '';
  state.feedbackSending = false;
  // Snapshot the caseID now, while detection still points at the form page.
  // renderSourcePhotosHtml reads this so the reference links survive later
  // tab switches / SPA navigations that mutate state.detection.url.
  state.caseId = extractCaseId(state.detection?.url || '');
  // Remember which page this run's output belongs to, so it can be cleared
  // when the panel later moves to a different page.
  state.pipelinePageKey = state.detection?.url || '';
  state.pipelineTabId = state.detection?.tabId ?? null;
  els.queueCard.style.display = 'none';
  els.btnSync.disabled = true;
  if (els.btnSendFeedback) {
    els.btnSendFeedback.disabled = true;
    setFeedbackButtonLabel('Send Feedback');
  }
  setStatusBadge('IN PROGRESS', 'progress');
  els.statusDesc.textContent = STATUS_DESCRIPTIONS.scraping;
  els.canvasTitle.textContent = 'Reading form';
  els.canvasSubtitle.textContent = 'Extracting questions and current answers.';
  setRingProgress(10);
  setRingSpinning(true);
  setConnection('idle', 'Working…');
  state.apiStartMs = Date.now();
  logActivity('Sync started');

  chrome.runtime.sendMessage({ action: 'SCRAPE_AND_VERIFY' }, (resp) => {
    if (chrome.runtime.lastError) return handlePipelineError(chrome.runtime.lastError.message);
    if (!resp?.success) return handlePipelineError(resp?.error || 'Unknown error');
    handlePipelineSuccess(resp);
  });
}

function handleProgress(msg) {
  if (msg.stage) {
    state.pipeline = msg.stage;
    els.statusDesc.textContent = STATUS_DESCRIPTIONS[msg.stage] || msg.message || '';
  }
  if (msg.message) els.canvasSubtitle.textContent = msg.message;
  if (typeof msg.progress === 'number') setRingProgress(msg.progress);
  if (msg.stage === 'scraping') els.canvasTitle.textContent = 'Reading form';
  if (msg.stage === 'uploading') els.canvasTitle.textContent = 'Processing';
  if (msg.stage === 'analyzing') els.canvasTitle.textContent = 'Analyzing';
}

/**
 * Visually blank the form-review output (canvas, ring, status, queue,
 * feedback) back to its neutral "Ready" state - WITHOUT discarding the stored
 * result. Called when the side panel moves to a page that isn't the one the
 * current output belongs to, so a result/backend error never bleeds onto an
 * unrelated page. The data (state.entries + Accept/Reject decisions) stays in
 * memory; restoreFormOutput() re-shows it when we return to its page.
 */
function clearFormOutputDisplay() {
  setStatusBadge('IDLE', 'idle');
  els.statusDesc.textContent = '';
  els.canvasTitle.textContent = 'Ready';
  els.canvasSubtitle.innerHTML = 'Click <strong>Sync &amp; Verify</strong> to start.';
  setRingProgress(0);
  setRingSpinning(false);
  setConnection('idle', 'Idle');
  if (els.queueCard) els.queueCard.style.display = 'none';
  if (els.btnSendFeedback) els.btnSendFeedback.disabled = true;
}

/**
 * Re-show the stored review queue (and its Accept/Reject decisions) when the
 * panel returns to the page the verify run belongs to. Only the verify flow
 * keeps a queue; KB-only / error results have no entries to restore, so they
 * simply stay blanked (the user can re-run if needed).
 */
function restoreFormOutput() {
  if (!state.entries.length) return;
  setStatusBadge('COMPLETE', 'success');
  els.canvasTitle.textContent = 'Analysis complete';
  els.canvasSubtitle.textContent = `Review ${state.entries.length} AI answers below.`;
  setRingProgress(100);
  setRingSpinning(false);
  setConnection('online', 'Online');
  renderQueue();
  if (els.queueCard) els.queueCard.style.display = 'block';
  if (els.btnSendFeedback) els.btnSendFeedback.disabled = false;
}

function handlePipelineError(message) {
  state.pipeline = 'error';
  setStatusBadge('ERROR', 'error');
  els.statusDesc.textContent = message;
  els.canvasTitle.textContent = 'Sync failed';
  els.canvasSubtitle.textContent = message;
  setRingProgress(0);
  setRingSpinning(false);
  setConnection('error', 'Backend error');
  els.btnSync.disabled = false;
  if (els.btnSendFeedback) els.btnSendFeedback.disabled = true;
  logActivity(`Error: ${message}`, 'error');
}

function handlePipelineSuccess(resp) {
  state.pipeline = 'complete';
  const latency = Date.now() - state.apiStartMs;
  state.surveyNumber = resp.surveyNumber || '';

  const flow = resp.flow || 'verify';

  // ── Chained flow abort (Dual form): cover save failed ───────────
  //   kb_then_verify runs the cover knowledge_base call first. If it fails
  //   the verify leg never ran, so there's no queue to show - render the
  //   same KB failure banners as the plain knowledge_base flow and stop.
  if (flow === 'kb_then_verify' && resp.coverFailed) {
    setRingSpinning(false);
    els.btnSync.disabled = false;
    state.entries = [];
    state.apiByQuestionId = {};
    state.resultId = '';
    if (els.queueCard) els.queueCard.style.display = 'none';
    if (els.btnSendFeedback) els.btnSendFeedback.disabled = true;

    const kb = resp.kbResult || {};
    setRingProgress(0);

    if (kb.kind === 'not_found') {
      setStatusBadge('NOT FOUND', 'warning');
      setConnection('error', 'Survey not found');
      els.canvasTitle.textContent = 'Survey not found';
      els.canvasSubtitle.textContent = kb.detail
        || `No survey found for survey_no: ${resp.surveyNumber || '-'}`;
      els.statusDesc.textContent = kb.detail || 'Survey not found in SmartFill.';
    } else if (kb.kind === 'invalid') {
      setStatusBadge('REJECTED', 'warning');
      setConnection('error', 'Request rejected');
      els.canvasTitle.textContent = 'Cover rejected - verify skipped';
      els.canvasSubtitle.textContent = kb.detail || 'The backend rejected the cover save.';
      els.statusDesc.textContent = kb.detail || 'Invalid request.';
    } else {
      setStatusBadge('ERROR', 'error');
      setConnection('error', 'Backend error');
      els.canvasTitle.textContent = kb.kind === 'network' ? 'Network error' : 'Cover save failed';
      els.canvasSubtitle.textContent = kb.detail
        || `HTTP ${kb.status || '???'} saving cover to SmartFill.`;
      els.statusDesc.textContent = kb.detail || 'Backend error.';
    }
    logActivity(`Cover save failed - verify skipped: ${kb.detail || 'unknown'}`, 'error');
    showToast(kb.detail || 'Cover save failed - verify skipped');
    return;
  }

  // ── SmartFill save flow (Cover, General Information) ─────────────
  //   No Accept/Reject queue - the backend returns either a saved-status
  //   record or a structured error (400 wrong page_type, 404 unknown
  //   survey). We surface that message verbatim in the canvas + status
  //   row, and show a toast.
  if (flow === 'knowledge_base') {
    setRingSpinning(false);
    els.btnSync.disabled = false;
    state.entries = [];
    state.apiByQuestionId = {};
    state.resultId = '';
    if (els.queueCard) els.queueCard.style.display = 'none';
    if (els.btnSendFeedback) els.btnSendFeedback.disabled = true;

    const kb = resp.kbResult || {};
    const formName = (resp.form && resp.form.name) || resp.pageType || 'SmartFill';

    if (kb.ok) {
      // 200: { status: "saved", survey_no, page_type }
      setStatusBadge('SAVED', 'success');
      setRingProgress(100);
      setConnection('online', 'Online');
      els.canvasTitle.textContent = 'Saved to SmartFill';
      els.canvasSubtitle.textContent =
        `${formName} for survey ${kb.survey_no || resp.surveyNumber || '-'} saved successfully.`;
      els.statusDesc.textContent = 'Saved to SmartFill.';
      logActivity(
        `Saved to SmartFill: ${formName} (survey ${kb.survey_no || resp.surveyNumber || '-'}, ${latency} ms)`,
        'success'
      );
      showToast('Saved to SmartFill');
      return;
    }

    // Failure paths. Each has its own banner copy so the user knows what
    // to fix - a wrong survey number vs. a backend-rejected page_type vs.
    // a network outage need different responses from the user.
    setRingProgress(0);
    setRingSpinning(false);
    els.btnSync.disabled = false;

    if (kb.kind === 'not_found') {
      // 404: { detail: "No survey found for survey_no: xyz" }
      setStatusBadge('NOT FOUND', 'warning');
      setConnection('error', 'Survey not found');
      els.canvasTitle.textContent = 'Survey not found';
      els.canvasSubtitle.textContent = kb.detail
        || `No survey found for survey_no: ${resp.surveyNumber || '-'}`;
      els.statusDesc.textContent = kb.detail || 'Survey not found in SmartFill.';
      logActivity(`SmartFill: ${kb.detail || 'survey not found'}`, 'error');
      showToast(kb.detail || 'Survey not found');
      return;
    }

    if (kb.kind === 'invalid') {
      // 400: { detail: "page_type must be 'general' or 'cover'" }
      setStatusBadge('REJECTED', 'warning');
      setConnection('error', 'Request rejected');
      els.canvasTitle.textContent = 'Backend rejected the request';
      els.canvasSubtitle.textContent = kb.detail || 'The backend rejected this request.';
      els.statusDesc.textContent = kb.detail || 'Invalid request.';
      logActivity(`SmartFill rejected: ${kb.detail || 'invalid request'}`, 'error');
      showToast(kb.detail || 'Request rejected');
      return;
    }

    // Network / unknown error.
    setStatusBadge('ERROR', 'error');
    setConnection('error', 'Backend error');
    els.canvasTitle.textContent = kb.kind === 'network' ? 'Network error' : 'Backend error';
    els.canvasSubtitle.textContent = kb.detail
      || `HTTP ${kb.status || '???'} from SmartFill.`;
    els.statusDesc.textContent = kb.detail || 'Backend error.';
    logActivity(`SmartFill error: ${kb.detail || 'unknown'}`, 'error');
    showToast(kb.detail || 'Backend error');
    return;
  }

  // ── Verify flow (Core Revised) - unchanged from the original path ──
  //   kb_then_verify successes also land here: the cover save already
  //   succeeded in the worker, so this is the verify leg's queue.
  if (flow === 'kb_then_verify' && resp.kbResult && resp.kbResult.ok) {
    logActivity(
      `Cover saved to SmartFill (survey ${resp.kbResult.survey_no || resp.surveyNumber || '-'})`,
      'success'
    );
  }
  setStatusBadge('COMPLETE', 'success');
  els.statusDesc.textContent = STATUS_DESCRIPTIONS.complete;
  els.canvasTitle.textContent = 'Analysis complete';
  els.canvasSubtitle.textContent = `Review ${resp.aiAnswers.length} AI answers below.`;
  setRingProgress(100);
  setRingSpinning(false);
  setConnection('online', 'Online');
  els.btnSync.disabled = false;

  // Capture the result_id from the verify response so the Send Feedback
  // button can tie its payload back to this AI run. Empty string when the
  // backend didn't send one (legacy shape).
  state.resultId = resp.resultId || '';

  resp.aiAnswers.forEach((aiItem) => {
    if (aiItem.type === 'question' && aiItem.questionId) {
      state.apiByQuestionId[aiItem.questionId] = aiItem;
    }
  });

  state.entries = buildEntries(resp.extracted.sections, state.apiByQuestionId);
  renderQueue();
  els.queueCard.style.display = 'block';
  // Feedback can be sent now that Sync finished. We don't gate on
  // result_id presence - the user can still submit feedback against an
  // empty id if the legacy backend is in play.
  if (els.btnSendFeedback) {
    els.btnSendFeedback.disabled = false;
    setFeedbackButtonLabel('Send Feedback');
  }
  logActivity(`Sync complete: ${state.entries.length} suggestions (${latency} ms)`, 'success');
}

// ─────────────────────────────────────────────────────────────────────
// 8.1  Entry model & mode derivation
// ─────────────────────────────────────────────────────────────────────
//
// Each AI response item now carries up to TWO independent suggestions:
//
//   formPass  - answer derived from form / knowledge-base pages.
//               Owns aiSourceLabels (which pages were consulted).
//   imagePass - answer derived from uploaded inspection images.
//               Owns aiSourcePhotoIds (which photos were used as evidence).
//
// Either pass may be null. When both are present they may agree or
// disagree. The entry's `mode` is computed once here from those facts:
//
//   caseA        both passes present and they disagree → 3-block view
//   caseB        both passes present and they agree    → verified merge
//   caseC-form   only formPass present                 → form-only block
//   caseC-image  only imagePass present                → image-only block
//   matched      every available pass already agrees with the inspector's
//                current value → minimal card, filtered into Matched tab
//
// `matchesCurrent` is true when every non-empty pass agrees with the
// current form value. It drives the Different / Matched filters.

/**
 * Decide whether a pass has a usable answer at all.
 *
 * The backend ships only `aiAnswer` on each pass - no per-pass options
 * array. So we read aiAnswer directly:
 *   radio    → non-empty string
 *   checkbox → array with at least one entry
 *   text/textarea/select → non-empty, non-"null" string
 */
// Statuses a "Matched" card can be in. Matched entries need no form edit -
// the inspector's value already agrees with the AI - but the reviewer can
// still tell us whether that agreed-on value is actually right:
//
//   matched            not reviewed yet
//   matched-correct    reviewer confirms the matched value is right
//   matched-incorrect  reviewer says the matched value is WRONG (both the
//                      form and the AI got it wrong)
//
// None of these write to the form. They exist purely so the value reaches
// the feedback payload as `reviewStatus` - see buildFeedbackPayload().
const MATCHED_STATUSES = ['matched', 'matched-correct', 'matched-incorrect'];

function isMatchedStatus(status) {
  return MATCHED_STATUSES.includes(status);
}

function passHasAnswer(pass, inputType) {
  if (!pass) return false;
  const a = pass.aiAnswer;
  if (a == null) return false;
  if (inputType === 'checkbox') {
    return Array.isArray(a) && a.length > 0;
  }
  // radio / text / textarea / select all use a string aiAnswer.
  if (typeof a !== 'string') return false;
  const trimmed = a.trim();
  return trimmed !== '' && trimmed !== 'null';
}

/**
 * Structural comparison between two passes for the same question.
 *
 * Checkbox: compare aiAnswer as a SET of labels (order-independent).
 * Everything else: trimmed string equality on aiAnswer.
 *
 * Either pass being absent makes them "not equal" - callers that care
 * about Case-B sameness will have already verified both are present.
 */
function passesEqual(passA, passB, inputType) {
  if (!passA || !passB) return false;
  if (inputType === 'checkbox') {
    const a = Array.isArray(passA.aiAnswer) ? passA.aiAnswer : [];
    const b = Array.isArray(passB.aiAnswer) ? passB.aiAnswer : [];
    if (a.length !== b.length) return false;
    const setA = new Set(a.map((s) => String(s).trim()));
    for (const v of b) if (!setA.has(String(v).trim())) return false;
    return true;
  }
  return String(passA.aiAnswer ?? '').trim() === String(passB.aiAnswer ?? '').trim();
}

/**
 * Does a pass's answer match the question's current on-page answer?
 * Used to detect "matched" entries that don't need user action.
 *
 * Radio: compare AI's aiAnswer (label string) to the currently-selected
 *        option's label on the page.
 * Checkbox: compare set of label strings.
 * Text: trimmed string equality.
 */
function passMatchesCurrent(pass, question) {
  if (!pass) return false;
  if (question.inputType === 'radio') {
    const orig = (question.options || []).find((o) => o.selected);
    return String(orig?.label ?? '').trim() === String(pass.aiAnswer ?? '').trim();
  }
  if (question.inputType === 'checkbox') {
    const currentLabels = Array.isArray(question.answer) ? question.answer : [];
    const aiLabels = Array.isArray(pass.aiAnswer) ? pass.aiAnswer : [];
    if (currentLabels.length !== aiLabels.length) return false;
    const setCur = new Set(currentLabels.map((s) => String(s).trim()));
    for (const v of aiLabels) if (!setCur.has(String(v).trim())) return false;
    return true;
  }
  return String(question.answer ?? '').trim() === String(pass.aiAnswer ?? '').trim();
}

function buildEntries(sections, apiByQuestionId) {
  const entries = [];
  sections.forEach((section) => {
    section.questions.forEach((q) => {
      const ai = apiByQuestionId[q.questionId];
      if (!ai) return;

      // Pull the two passes off the API item. Empty objects are normalised
      // to null so downstream checks can be a simple truthy test.
      const formPass = passHasAnswer(ai.formPass, q.inputType) ? ai.formPass : null;
      const imagePass = passHasAnswer(ai.imagePass, q.inputType) ? ai.imagePass : null;

      // Drop entries with no usable suggestion from either source.
      if (!formPass && !imagePass) return;

      // Decide mode from the two passes + their structural equality.
      let mode;
      if (formPass && imagePass) {
        mode = passesEqual(formPass, imagePass, q.inputType) ? 'caseB' : 'caseA';
      } else if (formPass) {
        mode = 'caseC-form';
      } else {
        mode = 'caseC-image';
      }

      // matchesCurrent = every available pass already agrees with the
      // inspector's current value. If true, the card is "Matched" and
      // doesn't need action.
      const formMatchesCur = formPass ? passMatchesCurrent(formPass, q) : true;
      const imageMatchesCur = imagePass ? passMatchesCurrent(imagePass, q) : true;
      const matchesCurrent = formMatchesCur && imageMatchesCur;

      entries.push({
        uid: q.questionUid,
        sectionText: q.sectionText,
        subheader: q.subheader,
        question: q,
        formPass,
        imagePass,
        mode,
        matchesCurrent,
        // Status starts as 'matched' when nothing needs attention, otherwise
        // 'pending'. Action handlers move it to one of:
        //   accepted-form | accepted-image | accepted-verified | rejected
        status: matchesCurrent ? 'matched' : 'pending',
      });
    });
  });
  return entries;
}

// ─────────────────────────────────────────────────────────────────────
// 8.2  Value formatting (display helpers)
// ─────────────────────────────────────────────────────────────────────

function formatAnswer(value) {
  if (value == null || value === '') return '-';
  if (Array.isArray(value)) return value.length === 0 ? '-' : value.join(', ');
  return String(value);
}

/**
 * Format a single pass's answer for display. The backend sends aiAnswer
 * as a label string (radio / text / select) or an array of label strings
 * (checkbox); we render those forms directly.
 */
function formatPassAnswer(question, pass) {
  if (!pass) return '-';
  if (question.inputType === 'checkbox') {
    const labels = Array.isArray(pass.aiAnswer)
      ? pass.aiAnswer.filter((s) => s != null && String(s).trim() !== '')
      : [];
    return labels.length ? labels.join(', ') : '-';
  }
  return formatAnswer(pass.aiAnswer);
}

// ─────────────────────────────────────────────────────────────────────
// 8.3  Filter logic
// ─────────────────────────────────────────────────────────────────────

function applyFilter(entries) {
  if (state.filter === 'different') return entries.filter((e) => !e.matchesCurrent);
  if (state.filter === 'matched') return entries.filter((e) => e.matchesCurrent);
  return entries;
}

function updateFilterCounts() {
  const total = state.entries.length;
  const different = state.entries.filter((e) => !e.matchesCurrent).length;
  const matchedCnt = state.entries.filter((e) => e.matchesCurrent).length;
  els.filterCountAll.textContent = total;
  els.filterCountDifferent.textContent = different;
  els.filterCountMatched.textContent = matchedCnt;
}

document.querySelectorAll('.filter-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    state.filter = tab.dataset.filter;
    document.querySelectorAll('.filter-tab').forEach((t) => {
      const active = t === tab;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    renderQueue();
  });
});

// Delegated handler for the verify "source photo" buttons. Lives on the
// stable list container so it survives card repaints (which replace each
// card's innerHTML). Stops propagation so the card's focus-on-click handler
// doesn't also fire.
els.suggestionList.addEventListener('click', (e) => {
  const btn = e.target.closest('.source-photo-link');
  if (!btn) return;
  e.stopPropagation();
  // Build a gallery from all the source-photo buttons in THIS question's
  // references row, opening at the one that was clicked.
  const listEl = btn.closest('.source-photos-list');
  const buttons = listEl
    ? Array.from(listEl.querySelectorAll('.source-photo-link'))
    : [btn];
  const urls = buttons.map((b) => b.dataset.imageUrl).filter(Boolean);
  const index = Math.max(0, buttons.indexOf(btn));
  openImageOnPage(urls, index);
});

// Delegated handler for the "Related pages" pills that resolved to knowledge
// text (see renderSourceLabelsHtml). Clicking one expands the excerpt the
// form-pass AI read off that page; clicking it again collapses it. Only one
// excerpt per references block stays open so the card can't grow unbounded.
// Same reasoning as the photo handler above for living on the list container.
els.suggestionList.addEventListener('click', (e) => {
  const pill = e.target.closest('.source-label-pill[data-kn-index]');
  if (!pill) return;
  e.stopPropagation();

  const box = pill.closest('.source-labels');
  if (!box) return;
  const panel = box.querySelector(`.source-knowledge[data-kn-panel="${pill.dataset.knIndex}"]`);
  if (!panel) return;

  const opening = panel.hidden;
  box.querySelectorAll('.source-knowledge').forEach((p) => { p.hidden = true; });
  box.querySelectorAll('.source-label-pill[data-kn-index]').forEach((b) => {
    b.setAttribute('aria-expanded', 'false');
    b.classList.remove('is-open');
  });
  if (opening) {
    panel.hidden = false;
    pill.setAttribute('aria-expanded', 'true');
    pill.classList.add('is-open');
  }
});

// ─────────────────────────────────────────────────────────────────────
// 8.4  Queue rendering
// ─────────────────────────────────────────────────────────────────────

function renderQueue() {
  const visible = applyFilter(state.entries);
  const emptyCopy = {
    all: {
      title: 'No suggestions yet',
      body: 'Run Sync to fetch AI-verified answers.'
    },
    different: {
      title: 'Nothing to review',
      body: 'Every answer is already verified - no conflicts found.'
    },
    matched: {
      title: 'No matches',
      body: 'No questions match yet - every suggestion needs review.'
    },
  }[state.filter];

  els.suggestionList.innerHTML = '';
  if (visible.length === 0) {
    els.suggestionList.innerHTML = `
      <div class="empty-state" style="padding:24px;">
        <div class="empty-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="1.6"
               stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </div>
        <p>${emptyCopy.title}</p>
        <span>${emptyCopy.body}</span>
      </div>
    `;
  } else {
    // Order: pending first (the work), then accepted, then rejected, then
    // matched (already-correct, lowest priority).
    const order = {
      pending: 0,
      'accepted-form': 1, 'accepted-image': 1, 'accepted-verified': 1,
      rejected: 2,
      matched: 3,
    };
    const sorted = [...visible].sort((a, b) => order[a.status] - order[b.status]);
    sorted.forEach((entry) => els.suggestionList.appendChild(renderSuggestion(entry)));
  }
  hydrateReferenceThumbnails();
  prefetchReferenceImages();
  updateFilterCounts();
  updateCounts();
  updateBulkBar();
}

function renderSuggestion(entry) {
  const node = document.createElement('div');
  node.className = `suggestion is-${entry.status} mode-${entry.mode}`;
  node.dataset.uid = entry.uid;
  fillSuggestion(node, entry);

  // Clicking the card (but not a button) scrolls the actual question into
  // view on the page and flashes it - same UX as before.
  node.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    focusQuestionInPage(entry.uid);
  });
  return node;
}

/**
 * Top-level filler. Decides which body layout to use based on status +
 * mode, then composes head, body, references and actions.
 */
function fillSuggestion(node, entry) {
  // Reset all status classes; one will be re-applied below.
  node.classList.remove(
    'is-pending',
    'is-accepted-form', 'is-accepted-image', 'is-accepted-verified',
    'is-rejected', 'is-matched', 'is-matched-correct', 'is-matched-incorrect'
  );
  node.classList.add(`is-${entry.status}`);

  // Re-apply mode class (lost on reset above)
  ['mode-caseA', 'mode-caseB', 'mode-caseC-form', 'mode-caseC-image', 'mode-matched'].forEach((c) => {
    node.classList.remove(c);
  });
  node.classList.add(`mode-${entry.mode}`);

  const head = renderHead(entry);
  const banner = renderStatusBanner(entry);
  const body = renderBody(entry);
  const references = renderReferencesRow(entry);
  const actions = renderActions(entry);

  node.innerHTML = [head, banner, body, references, actions]
    .filter(Boolean)
    .join('');
}

// ─────────────────────────────────────────────────────────────────────
// 8.5  Card chrome (head + status banner)
// ─────────────────────────────────────────────────────────────────────

function renderHead(entry) {
  const subhead = entry.subheader ? ` · ${escapeHtml(entry.subheader)}` : '';
  const statusPill = renderStatusPill(entry);
  return `
    <div class="suggestion-head">
      <div style="min-width:0;flex:1;">
        <div class="suggestion-section">${escapeHtml(entry.sectionText || 'General')}${subhead}</div>
        <div class="suggestion-question">${escapeHtml(entry.question.questionText || '(no label)')}</div>
      </div>
      ${statusPill}
    </div>
  `;
}

function renderStatusPill(entry) {
  const map = {
    pending: { label: 'Needs review', cls: 'is-pending' },
    'accepted-form': { label: 'Form applied', cls: 'is-accepted' },
    'accepted-image': { label: 'Image applied', cls: 'is-accepted' },
    'accepted-verified': { label: 'Verified applied', cls: 'is-accepted' },
    rejected: { label: 'Rejected', cls: 'is-rejected' },
    matched: { label: 'Matches', cls: 'is-matched' },
    'matched-correct': { label: 'Confirmed', cls: 'is-accepted' },
    'matched-incorrect': { label: 'Marked wrong', cls: 'is-flagged' },
  };
  const m = map[entry.status] || map.pending;
  return `<span class="suggestion-status ${m.cls}">${m.label}</span>`;
}

/**
 * Big status banner shown across the top of the card body when the user
 * has taken an action. Hidden for pending and matched states (where the
 * body itself communicates the state).
 */
function renderStatusBanner(entry) {
  if (entry.status === 'pending' || entry.status === 'matched') return '';

  const map = {
    'matched-correct': {
      cls: 'banner-success',
      icon: 'check',
      text: 'Confirmed correct - recorded for feedback only, the form was not changed.',
    },
    'matched-incorrect': {
      cls: 'banner-danger',
      icon: 'x',
      text: 'Marked incorrect - recorded for feedback only, the form was not changed.',
    },
    'accepted-form': {
      cls: 'banner-success',
      icon: 'check',
      text: 'Applied: page/form-based answer was written to the form.',
    },
    'accepted-image': {
      cls: 'banner-success',
      icon: 'check',
      text: 'Applied: AI answer was written to the form.',
    },
    'accepted-verified': {
      cls: 'banner-success',
      icon: 'check',
      text: 'Applied: verified answer was written to the form.',
    },
    rejected: {
      cls: 'banner-muted',
      icon: 'x',
      text: 'Rejected - no changes were made to this question.',
    },
  };
  const b = map[entry.status];
  if (!b) return '';
  const iconSvg = b.icon === 'check'
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2.4"
            stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2.4"
            stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  return `<div class="applied-banner ${b.cls}">${iconSvg}<span>${escapeHtml(b.text)}</span></div>`;
}

// ─────────────────────────────────────────────────────────────────────
// 8.6  Card body - branches on mode (and status for post-action layout)
// ─────────────────────────────────────────────────────────────────────

function renderBody(entry) {
  // After the user has taken an action, the body collapses to a compact
  // "current → applied value" or "current value preserved" view. The full
  // suggestion blocks would just be visual noise at this point.
  //
  // Matched cards are the exception: confirming / flagging one changes
  // nothing on the form, so the body keeps showing the comparison that the
  // reviewer just ruled on.
  if (entry.status !== 'pending' && !isMatchedStatus(entry.status)) {
    return renderPostActionBody(entry);
  }

  switch (entry.mode) {
    case 'caseA': return renderCaseABody(entry);
    case 'caseB': return renderCaseBBody(entry);
    case 'caseC-form': return renderCaseCBody(entry, 'form');
    case 'caseC-image': return renderCaseCBody(entry, 'image');
    case 'matched':
    default: return renderMatchedBody(entry);
  }
}

/**
 * Three-block layout: current / form suggestion / image suggestion.
 * Used when both passes exist and they disagree.
 */
function renderCaseABody(entry) {
  const current = renderAnswerBlock({
    kind: 'current',
    title: 'Current Form Value',
    helper: 'The answer currently saved on the inspection form.',
    value: formatAnswer(entry.question.answer),
  });
  const form = renderAnswerBlock({
    kind: 'form',
    title: 'Page / Form Suggestion',
    helper: 'This answer was extracted from the inspection form pages.',
    value: formatPassAnswer(entry.question, entry.formPass),
  });
  const image = renderAnswerBlock({
    kind: 'image',
    title: 'AI Suggestion',
    helper: 'This answer was identified from uploaded inspection images.',
    value: formatPassAnswer(entry.question, entry.imagePass),
  });
  const conflictHeader = `
    <div class="conflict-header" role="status">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.4"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/>
        <line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <span>Sources disagree - pick the answer to apply, or reject both.</span>
    </div>
  `;
  return `${conflictHeader}<div class="suggestion-blocks blocks-3">${current}${form}${image}</div>`;
}

/**
 * Two-block layout: current vs. merged verified suggestion.
 * Used when both passes exist and agree. Picks the form pass arbitrarily
 * as the "canonical" value since both are structurally identical.
 */
function renderCaseBBody(entry) {
  const current = renderAnswerBlock({
    kind: 'current',
    title: 'Current Form Value',
    helper: 'The answer currently saved on the inspection form.',
    value: formatAnswer(entry.question.answer),
  });
  const verified = renderAnswerBlock({
    kind: 'verified',
    title: 'Verified Suggested Answer',
    helper: 'Both page data and image analysis agree on this answer.',
    value: formatPassAnswer(entry.question, entry.formPass),
    icon: 'shield-check',
  });
  return `<div class="suggestion-blocks blocks-2">${current}${verified}</div>`;
}

/**
 * Two-block layout: current vs. the one pass that exists.
 * `which` is 'form' or 'image'.
 */
function renderCaseCBody(entry, which) {
  const pass = which === 'form' ? entry.formPass : entry.imagePass;
  const current = renderAnswerBlock({
    kind: 'current',
    title: 'Current Form Value',
    helper: 'The answer currently saved on the inspection form.',
    value: formatAnswer(entry.question.answer),
  });
  const suggestion = which === 'form'
    ? renderAnswerBlock({
      kind: 'form',
      title: 'Page / Form Suggestion',
      helper: 'This answer was extracted from the inspection form pages.',
      value: formatPassAnswer(entry.question, pass),
    })
    : renderAnswerBlock({
      kind: 'image',
      title: 'AI Suggestion',
      helper: 'This answer was identified from uploaded inspection images.',
      value: formatPassAnswer(entry.question, pass),
    });
  return `<div class="suggestion-blocks blocks-2">${current}${suggestion}</div>`;
}

/**
 * Compact one-row layout for already-correct questions.
 */
function renderMatchedBody(entry) {
  return `
    <div class="matched-row">
      <div class="matched-icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2.4"
             stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
      <div class="matched-text">
        <div class="matched-title">Matches</div>
        <div class="matched-value">${escapeHtml(formatAnswer(entry.question.answer))}</div>
      </div>
    </div>
  `;
}

/**
 * Post-action body - used for accepted-* and rejected statuses. Shows a
 * compact summary so the user can still see what was applied / what was
 * preserved, and click Reconsider to undo.
 */
function renderPostActionBody(entry) {
  let appliedTitle, appliedValue, appliedKind;
  switch (entry.status) {
    case 'accepted-form':
      appliedTitle = 'Applied Page / Form Answer';
      appliedValue = formatPassAnswer(entry.question, entry.formPass);
      appliedKind = 'form';
      break;
    case 'accepted-image':
      appliedTitle = 'Applied AI Answer';
      appliedValue = formatPassAnswer(entry.question, entry.imagePass);
      appliedKind = 'image';
      break;
    case 'accepted-verified':
      appliedTitle = 'Applied Verified Answer';
      appliedValue = formatPassAnswer(entry.question, entry.formPass);
      appliedKind = 'verified';
      break;
    case 'rejected':
      // Show the current value (preserved) instead of an applied value.
      return `
        <div class="suggestion-blocks blocks-1">
          ${renderAnswerBlock({
        kind: 'current',
        title: 'Current Form Value (Unchanged)',
        helper: 'No changes were applied. Click Reconsider to review again.',
        value: formatAnswer(entry.question.answer),
      })}
        </div>
      `;
    default:
      return '';
  }
  return `
    <div class="suggestion-blocks blocks-1">
      ${renderAnswerBlock({
    kind: appliedKind,
    title: appliedTitle,
    helper: 'This value is now on the inspection form. Click Reconsider to revert.',
    value: appliedValue,
  })}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────
// 8.7  Reusable answer-block component
// ─────────────────────────────────────────────────────────────────────

/**
 * The unit of the new layout. Renders a single labelled answer card with
 * a kind-specific color treatment.
 *
 *   kind: 'current' | 'form' | 'image' | 'verified'
 *   title:  short header (e.g. "Current Form Value")
 *   helper: one-sentence helper text under the value
 *   value:  the actual answer to show
 *   icon:   optional 'shield-check' badge (used for verified blocks)
 */
function renderAnswerBlock({ kind, title, helper, value, icon }) {
  const iconHtml = icon === 'shield-check'
    ? `<span class="answer-block-icon" aria-hidden="true">
         <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2.4"
              stroke-linecap="round" stroke-linejoin="round">
           <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
           <polyline points="9 12 11 14 15 10"/>
         </svg>
       </span>`
    : '';
  return `
    <div class="answer-block answer-block--${escapeHtml(kind)}">
      <div class="answer-block-head">
        ${iconHtml}<span class="answer-block-title">${escapeHtml(title)}</span>
      </div>
      <div class="answer-block-value">${escapeHtml(value)}</div>
      ${helper ? `<div class="answer-block-helper">${escapeHtml(helper)}</div>` : ''}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────
// 8.8  References row (source photos + related pages)
// ─────────────────────────────────────────────────────────────────────
//
// Photo references live on imagePass.aiSourcePhotoIds.
// Page-label references live on formPass.aiSourceLabels.
// We show both cleanly when both exist. After an action, references are
// hidden to keep the post-action card compact.

function renderReferencesRow(entry) {
  if (entry.status !== 'pending' && !isMatchedStatus(entry.status)) return '';

  const photoIds = (entry.imagePass && Array.isArray(entry.imagePass.aiSourcePhotoIds))
    ? entry.imagePass.aiSourcePhotoIds
    : [];
  const labels = (entry.formPass && Array.isArray(entry.formPass.aiSourceLabels))
    ? entry.formPass.aiSourceLabels.filter((s) => typeof s === 'string' && s.trim() !== '')
    : [];

  const photosHtml = renderSourcePhotosHtml(photoIds);
  const labelsHtml = renderSourceLabelsHtml(labels, entry.formPass);
  if (!photosHtml && !labelsHtml) return '';
  return `<div class="references-row">${photosHtml}${labelsHtml}</div>`;
}

/**
 * Clickable links to the case photos the image-pass AI used as evidence.
 * Returns '' when there are no photos, or when we can't build a
 * case-scoped URL because the page URL lacks caseID.
 */
function renderSourcePhotosHtml(photoIds) {
  if (!photoIds || photoIds.length === 0) return '';
  // Prefer the caseID snapshotted when the pipeline ran (state.caseId); fall
  // back to the live detection URL only if it wasn't captured. This keeps the
  // links stable when the active tab/URL changes after the queue is built.
  const caseId = state.caseId || extractCaseId(state.detection?.url || '');
  if (!caseId) return '';

  const links = photoIds.map((pid, i) => {
    const href = buildPhotoHandlerUrl(caseId, pid);
    if (!href) return '';
    // A thumbnail button (not an <a target=_blank>): clicking opens the image
    // in the on-page modal via openImageOnPage(). The class + data-image-url
    // are unchanged, so the delegated handler on els.suggestionList still
    // works. The <img> loads the photo directly (cross-origin); if that fails
    // for want of session cookies, hydrateReferenceThumbnails() swaps in a
    // content-script-fetched data URL.
    return `
      <button type="button" class="source-photo-link"
         data-image-url="${escapeHtml(href)}"
         title="${escapeHtml(pid)}" aria-label="Source image ${i + 1}">
        <img class="source-photo-thumb" src="${escapeHtml(href)}"
             data-thumb-url="${escapeHtml(href)}"
             alt="Source image ${i + 1}" loading="lazy" />
      </button>
    `;
  }).join('');

  return `
    <div class="source-photos">
      <div class="source-photos-label">Source photos · ${photoIds.length}</div>
      <div class="source-photos-list">${links}</div>
    </div>
  `;
}

/**
 * Warm the on-page image cache so clicking a source-photo thumbnail opens the
 * modal instantly. We gather every reference photo across the current pending /
 * matched entries and hand the photoHandler URLs to the content script, which
 * fetches them once (on the LC360 tab, with cookies) and keeps object URLs
 * ready for the modal. Only URLs travel over the message - never image bytes -
 * so this stays cheap. Idempotent: the page skips already-cached URLs, so
 * calling it on every queue render costs nothing after the first pass.
 */
function prefetchReferenceImages() {
  const caseId = state.caseId || extractCaseId(state.detection?.url || '');
  if (!caseId) return;

  const urls = [];
  const seen = new Set();
  state.entries.forEach((entry) => {
    if (entry.status !== 'pending' && !isMatchedStatus(entry.status)) return;
    const ids = entry.imagePass && entry.imagePass.aiSourcePhotoIds;
    if (!Array.isArray(ids)) return;
    ids.forEach((pid) => {
      const url = buildPhotoHandlerUrl(caseId, pid);
      if (url && !seen.has(url)) { seen.add(url); urls.push(url); }
    });
  });
  if (!urls.length) return;

  const msg = { action: 'PREFETCH_IMAGES', images: urls };
  const tabId = state.detection && state.detection.tabId;
  if (typeof tabId === 'number') msg.targetTabId = tabId;
  chrome.runtime.sendMessage(msg, () => { void chrome.runtime.lastError; });
}

/**
 * Ask the content script (running on the LC360 tab, so the request carries the
 * page's session cookies) to fetch an image and return it as a base64 data
 * URL. Lighter than fetchImageBlob() - we skip the Blob round-trip and use the
 * data URL straight as an <img src>. `targetTabId` pins the fetch to the LC360
 * tab even if the user has since tabbed away.
 */
function fetchImageDataUrl(imageUrl, targetTabId) {
  return new Promise((resolve, reject) => {
    const msg = { action: 'FETCH_IMAGE_BLOB', imageUrl };
    if (typeof targetTabId === 'number') msg.targetTabId = targetTabId;
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response || response.error || !response.dataUrl) {
        return reject(new Error(response ? response.error : 'No response'));
      }
      resolve(response.dataUrl);
    });
  });
}

/**
 * Reference-photo thumbnails load their <img> directly from photoHandler. That
 * works whenever the browser sends LC360 session cookies on the cross-origin
 * request (same path the Order Photos gallery relies on). When it doesn't
 * (cookies withheld → 403/blank), we fall back to a content-script fetch on the
 * LC360 tab, which always carries cookies, and swap the resulting data URL in.
 *
 * Called after every queue render / single-card repaint. `data-hydrated` marks
 * imgs we've already wired so re-renders don't double-attach; the per-URL
 * cache (state.refThumbCache) means a fallback fetch happens at most once per
 * distinct photo across all renders.
 */
function hydrateReferenceThumbnails() {
  const imgs = els.suggestionList.querySelectorAll(
    'img.source-photo-thumb:not([data-hydrated])'
  );
  imgs.forEach((img) => {
    img.setAttribute('data-hydrated', '1');
    const url = img.getAttribute('data-thumb-url');
    if (!url) return;

    // A prior fallback already produced a data URL for this photo → use it and
    // skip the direct load entirely.
    const cached = state.refThumbCache[url];
    if (cached) { img.src = cached; return; }

    const fallback = () => {
      img.removeEventListener('error', fallback);
      fetchImageDataUrl(url, state.detection && state.detection.tabId)
        .then((dataUrl) => {
          state.refThumbCache[url] = dataUrl;
          img.src = dataUrl;
          const btn = img.closest('.source-photo-link');
          if (btn) btn.classList.remove('is-thumb-failed');
        })
        .catch(() => {
          const btn = img.closest('.source-photo-link');
          if (btn) btn.classList.add('is-thumb-failed');
        });
    };

    img.addEventListener('error', fallback);
    // The direct src may have already failed before this listener attached
    // (e.g. a cached 403): complete + zero natural size means it errored.
    if (img.complete && img.naturalWidth === 0) fallback();
  });
}

// ── Knowledge-base excerpts behind the "Related pages" pills ─────────
//
// formPass carries, alongside aiSourceLabels, the raw text the AI actually
// read off each page:
//
//   generalKnowledge - { "<section>": <value>, ... } from the General form
//   coverKnowledge   - { "<section>": <value>, ... } from the Cover form
//
// A label ("Cover form: Protection") names the bucket before the colon and
// the key inside it after. When we can resolve a label to its text, the pill
// becomes a button that expands the excerpt inline; otherwise it stays the
// plain informational tag it has always been.

const KNOWLEDGE_SOURCES = [
  { test: /cover/i, field: 'coverKnowledge', origin: 'Cover form' },
  { test: /general/i, field: 'generalKnowledge', origin: 'General form' },
];

/**
 * Flatten a knowledge value into displayable text. Values are usually plain
 * strings, but the backend occasionally nests an object or a list under a
 * section, so those are rendered as one "key: value" / bullet per line.
 */
function formatKnowledgeValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map(formatKnowledgeValue).filter((s) => s !== '').join('\n');
  }
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([k, v]) => {
        const text = formatKnowledgeValue(v);
        return text === '' ? '' : `${k}: ${text}`;
      })
      .filter((s) => s !== '')
      .join('\n');
  }
  return '';
}

/** Keys of a knowledge bucket, or [] when the bucket is null / not an object. */
function knowledgeKeys(bucket) {
  if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) return [];
  return Object.keys(bucket);
}

/** Exact key hit, falling back to a trimmed case-insensitive match. */
function knowledgeByKey(bucket, key) {
  const keys = knowledgeKeys(bucket);
  if (!keys.length || !key) return null;
  if (Object.prototype.hasOwnProperty.call(bucket, key)) return { key, value: bucket[key] };
  const want = key.trim().toLowerCase();
  const hit = keys.find((k) => k.trim().toLowerCase() === want);
  return hit ? { key: hit, value: bucket[hit] } : null;
}

/**
 * Resolve a source label to the knowledge text it refers to.
 * Returns { origin, key, text } or null when there's nothing to show.
 */
function lookupSourceKnowledge(label, formPass) {
  if (!formPass || typeof label !== 'string') return null;

  const sep = label.indexOf(':');
  const prefix = sep === -1 ? label : label.slice(0, sep);
  const key = (sep === -1 ? label : label.slice(sep + 1)).trim();

  // The prefix names a bucket; search it first, then the other one in case
  // the backend labelled it loosely.
  const preferred = KNOWLEDGE_SOURCES.filter((s) => s.test.test(prefix));
  const rest = KNOWLEDGE_SOURCES.filter((s) => !preferred.includes(s));

  for (const src of preferred.concat(rest)) {
    const hit = knowledgeByKey(formPass[src.field], key);
    if (!hit) continue;
    const text = formatKnowledgeValue(hit.value);
    if (text) return { origin: src.origin, key: hit.key, text };
  }

  // No key matched. Label wording drifts between backend versions ("Cover
  // form: Protection" vs a bare "Cover page"), so when exactly one candidate
  // bucket holds exactly one entry there is nothing else the label could mean.
  const candidates = (preferred.length ? preferred : KNOWLEDGE_SOURCES)
    .filter((s) => knowledgeKeys(formPass[s.field]).length === 1);
  if (candidates.length === 1) {
    const src = candidates[0];
    const only = knowledgeKeys(formPass[src.field])[0];
    const text = formatKnowledgeValue(formPass[src.field][only]);
    if (text) return { origin: src.origin, key: only, text };
  }

  return null;
}

/**
 * Pills listing the knowledge-base pages the form-pass AI consulted
 * (e.g. "Cover form: Protection"). A pill whose label resolves to knowledge
 * text renders as a button paired with a collapsed excerpt panel below the
 * list; the panel is toggled by the delegated handler in section 8.3, and
 * the pill's tooltip carries a truncated preview for a quick hover read.
 * Labels with no matching text keep the original non-interactive tag.
 */
function renderSourceLabelsHtml(labels, formPass) {
  if (!labels || labels.length === 0) return '';

  const pageIcon = `
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
    </svg>`;

  const panels = [];
  const pills = labels.map((label) => {
    const knowledge = lookupSourceKnowledge(label, formPass);

    if (!knowledge) {
      return `
        <span class="source-label-pill" title="Reference page: ${escapeHtml(label)}">
          ${pageIcon}<span>${escapeHtml(label)}</span>
        </span>
      `;
    }

    // Index is generated here, so it's safe to interpolate into a selector.
    const idx = panels.length;
    panels.push(`
      <div class="source-knowledge" data-kn-panel="${idx}" hidden>
        <div class="source-knowledge-head">
          <span class="source-knowledge-key">${escapeHtml(knowledge.key)}</span>
          <span class="source-knowledge-origin">${escapeHtml(knowledge.origin)}</span>
        </div>
        <div class="source-knowledge-body">${escapeHtml(knowledge.text)}</div>
      </div>
    `);

    return `
      <button type="button" class="source-label-pill is-expandable"
              data-kn-index="${idx}" aria-expanded="false"
              title="${escapeHtml(truncate(knowledge.text, 400))}">
        ${pageIcon}<span>${escapeHtml(label)}</span>
        <svg class="source-label-caret" width="10" height="10" viewBox="0 0 24 24"
             fill="none" stroke="currentColor" stroke-width="3"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
    `;
  }).join('');

  return `
    <div class="source-photos source-labels">
      <div class="source-photos-label">Related pages · ${labels.length}</div>
      <div class="source-photos-list">${pills}</div>
      ${panels.length ? `<div class="source-knowledge-panels">${panels.join('')}</div>` : ''}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────
// 8.9  Action buttons - switches on mode + status
// ─────────────────────────────────────────────────────────────────────

function renderActions(entry) {
  let buttons = '';

  // Post-action states: just a Reconsider button.
  if (entry.status === 'accepted-form' ||
    entry.status === 'accepted-image' ||
    entry.status === 'accepted-verified' ||
    entry.status === 'rejected') {
    buttons = `<button class="action-btn action-reconsider" data-act="reconsider">Reconsider</button>`;
  } else if (entry.status === 'matched-correct' || entry.status === 'matched-incorrect') {
    // Reviewed matched card - only offer a way back. Nothing was written to
    // the form, so Reconsider just clears the verdict.
    buttons = `<button class="action-btn action-reconsider" data-act="reconsider">Reconsider</button>`;
  } else if (entry.status === 'matched') {
    // The form already agrees with the AI, so there is nothing to apply.
    // These two buttons are feedback-only: they never touch the form, they
    // just record whether the agreed-on value is actually right so the
    // backend can spot questions where form and AI were wrong together.
    buttons = `
      <button class="action-btn action-mark-incorrect" data-act="matched-incorrect">Mark Incorrect</button>
      <button class="action-btn action-mark-correct" data-act="matched-correct">Confirm Correct</button>
    `;
  } else {
    // Pending - branches on mode.
    switch (entry.mode) {
      case 'caseA':
        buttons = `
          <button class="action-btn action-reject" data-act="reject-both">Reject Both</button>
          <button class="action-btn action-apply-form" data-act="apply-form">Use Page / Form Answer</button>
          <button class="action-btn action-apply-image" data-act="apply-image">Use Image / AI Answer</button>
        `;
        break;
      case 'caseB':
        buttons = `
          <button class="action-btn action-reject" data-act="reject">Reject</button>
          <button class="action-btn action-apply-verified" data-act="apply-verified">Apply Verified Answer</button>
        `;
        break;
      case 'caseC-form':
        buttons = `
          <button class="action-btn action-reject" data-act="reject">Reject</button>
          <button class="action-btn action-apply-form" data-act="apply-form">Apply Page / Form Answer</button>
        `;
        break;
      case 'caseC-image':
        buttons = `
          <button class="action-btn action-reject" data-act="reject">Reject</button>
          <button class="action-btn action-apply-image" data-act="apply-image">Apply Image / AI Answer</button>
        `;
        break;
      default:
        buttons = '';
    }
  }
  return buttons ? `<div class="suggestion-actions">${buttons}</div>` : '';
}

// Event delegation: one listener on the suggestion list handles every
// button click on every card. Data-act tells us what to do.
els.suggestionList.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  e.stopPropagation();
  const card = btn.closest('.suggestion');
  if (!card) return;
  const entry = state.entries.find((x) => x.uid === card.dataset.uid);
  if (!entry) return;
  switch (btn.dataset.act) {
    case 'apply-form': return acceptForm(entry);
    case 'apply-image': return acceptImage(entry);
    case 'apply-verified': return acceptVerified(entry);
    case 'reject': return rejectEntry(entry);
    case 'reject-both': return rejectEntry(entry);
    case 'matched-correct': return markMatched(entry, 'matched-correct');
    case 'matched-incorrect': return markMatched(entry, 'matched-incorrect');
    case 'reconsider': return reconsiderEntry(entry);
  }
});

// ─────────────────────────────────────────────────────────────────────
// 8.10  Counts + bulk bar
// ─────────────────────────────────────────────────────────────────────

function updateCounts() {
  const pending = state.entries.filter((e) => e.status === 'pending').length;
  const accepted = state.entries.filter((e) =>
    e.status === 'accepted-form' ||
    e.status === 'accepted-image' ||
    e.status === 'accepted-verified'
  ).length;
  const rejected = state.entries.filter((e) => e.status === 'rejected').length;
  els.countPending.textContent = pending;
  els.countAccepted.textContent = accepted;
  els.countRejected.textContent = rejected;
}

function updateBulkBar() {
  const anyPending = state.entries.some((e) => e.status === 'pending');
  // Reject-all is a no-op on the form DOM, safe to expose. Accept-all
  // applies whichever pass is available for each pending entry (verified
  // > form > image), letting the user bulk-confirm AI suggestions at once.
  els.btnRejectAll.style.display = anyPending ? 'inline-flex' : 'none';
  els.btnAcceptAll.style.display = anyPending ? 'inline-flex' : 'none';
}

function repaintEntry(entry) {
  const node = els.suggestionList.querySelector(`.suggestion[data-uid="${CSS.escape(entry.uid)}"]`);
  if (node) fillSuggestion(node, entry);
  hydrateReferenceThumbnails();
  updateCounts();
  updateBulkBar();
}

// ─────────────────────────────────────────────────────────────────────
// 8.11  Action handlers
// ─────────────────────────────────────────────────────────────────────
//
// All three "apply" actions funnel into applyPass(), which builds an
// aiItem-shaped shim from the chosen pass and reuses the existing
// APPLY_ANSWER message + content-script writer. The writer is untouched.

function acceptForm(entry) {
  if (!entry.formPass) return;
  applyPass(entry, 'form');
}

function acceptImage(entry) {
  if (!entry.imagePass) return;
  applyPass(entry, 'image');
}

function acceptVerified(entry) {
  // formPass and imagePass are structurally identical in Case B, so
  // either works. Pick formPass arbitrarily.
  const pass = entry.formPass || entry.imagePass;
  if (!pass) return;
  applyPassWithShim(entry, pass, 'accepted-verified', 'verified');
}

function applyPass(entry, which) {
  const pass = which === 'form' ? entry.formPass : entry.imagePass;
  if (!pass) return;
  const newStatus = which === 'form' ? 'accepted-form' : 'accepted-image';
  applyPassWithShim(entry, pass, newStatus, which);
}

/**
 * Build an aiItem-shaped shim (the legacy shape the writer expects) from
 * a pass object, dispatch APPLY_ANSWER, and reflect the result in the UI.
 *
 *   pass        - { aiAnswer, ... } from formPass or imagePass
 *   newStatus   - the entry status to move to on success
 *   kindLabel   - 'form' | 'image' | 'verified' (used for activity log copy)
 */
function applyPassWithShim(entry, pass, newStatus, kindLabel) {
  const q = entry.question;
  const shim = {
    inputType: q.inputType,
    inputElementId: q.inputElementId,
    aiAnswer: pass.aiAnswer,
    options: synthesizeOptions(q, pass),
  };
  chrome.runtime.sendMessage(
    { action: 'APPLY_ANSWER', question: q, aiItem: shim },
    (resp) => {
      if (resp?.ok) {
        entry.status = newStatus;
        repaintEntry(entry);
        const label = truncate(q.questionText, 60);
        const verb = kindLabel === 'verified' ? 'Applied verified' :
          kindLabel === 'form' ? 'Applied form' :
            'Applied image';
        logActivity(`${verb}: "${label}"`, 'success');
        saveFeedbackDraft();
      } else {
        showToast(`Failed: ${resp?.error || 'unknown'}`);
        logActivity(`Apply failed: ${resp?.error || 'unknown'}`, 'error');
      }
    }
  );
}

/**
 * Build the options[] array the writer expects, by projecting the pass's
 * aiAnswer (a label string or array of label strings) onto the question's
 * own options[] and stamping the aiSelected flag on the matched ones.
 *
 * Matching is case-insensitive and trim-tolerant - backend label casing
 * occasionally drifts from the on-page label.
 *
 * For text/textarea/select inputs there are no options to mark, so we
 * return the question's options unchanged (typically empty).
 */
function synthesizeOptions(question, pass) {
  const baseOptions = Array.isArray(question.options) ? question.options : [];
  if (question.inputType !== 'radio' && question.inputType !== 'checkbox') {
    return baseOptions;
  }
  const wanted = question.inputType === 'checkbox'
    ? new Set(
      (Array.isArray(pass.aiAnswer) ? pass.aiAnswer : [])
        .map((s) => String(s ?? '').trim().toLowerCase())
        .filter((s) => s !== '')
    )
    : new Set(
      pass.aiAnswer != null
        ? [String(pass.aiAnswer).trim().toLowerCase()]
        : []
    );
  return baseOptions.map((o) => ({
    ...o,
    aiSelected: wanted.has(String(o.label ?? '').trim().toLowerCase()),
  }));
}

function rejectEntry(entry) {
  entry.status = 'rejected';
  repaintEntry(entry);
  logActivity(`Rejected: "${truncate(entry.question.questionText, 60)}"`);
  saveFeedbackDraft();
  focusQuestionInPage(entry.uid);
}

/**
 * Record a verdict on a Matched card. Deliberately does NOT send
 * APPLY_ANSWER - the form already holds this value and we must not rewrite
 * it. The only effect is entry.status, which buildFeedbackPayload() reports
 * as reviewStatus so the backend learns which "agreed" answers were wrong.
 */
function markMatched(entry, status) {
  entry.status = status;
  repaintEntry(entry);
  const verdict = status === 'matched-correct' ? 'Confirmed correct' : 'Marked incorrect';
  logActivity(`${verdict} (feedback only): "${truncate(entry.question.questionText, 60)}"`);
  focusQuestionInPage(entry.uid);
}

/**
 * Reconsider: clean wipe back to pending.
 *
 * If a value was applied to the form (any accepted-* state), REVERT_ANSWER
 * is sent first so the form input goes back to its original value. The
 * card then snaps back to its original Case A/B/C layout with no memory
 * of the previous choice.
 */
function reconsiderEntry(entry) {
  const wasApplied =
    entry.status === 'accepted-form' ||
    entry.status === 'accepted-image' ||
    entry.status === 'accepted-verified';

  if (wasApplied) {
    chrome.runtime.sendMessage(
      { action: 'REVERT_ANSWER', question: entry.question },
      (resp) => {
        if (resp?.ok) {
          entry.status = 'pending';
          repaintEntry(entry);
          saveFeedbackDraft();
          logActivity(`Reconsidering: reverted "${truncate(entry.question.questionText, 60)}"`);
        } else {
          showToast(`Revert failed: ${resp?.error || 'unknown'}`);
        }
      }
    );
  } else {
    // Rejected / matched-verdict → back to the card's resting state. Nothing
    // was written to the form, so no revert round-trip is needed. Matched
    // cards return to 'matched' rather than 'pending' - they never had a
    // change to apply in the first place.
    entry.status = isMatchedStatus(entry.status) ? 'matched' : 'pending';
    repaintEntry(entry);
    saveFeedbackDraft();
    logActivity(`Reconsidering: "${truncate(entry.question.questionText, 60)}"`);
    focusQuestionInPage(entry.uid);
  }
}

els.btnRejectAll.addEventListener('click', () => {
  const pending = state.entries.filter((e) => e.status === 'pending');
  pending.forEach((e) => { e.status = 'rejected'; repaintEntry(e); });
  saveFeedbackDraft();
  showToast(`Rejected ${pending.length} suggestions`);
  logActivity(`Bulk reject: ${pending.length} entries`);
});

// Accept-all: for every pending entry, accept whichever pass is available.
// Preference order is verified (Case B - both passes agree) > formPass
// (Case A/C form side) > imagePass (Case A image side). Entries with no
// pass at all are skipped. Each accept goes through the same APPLY_ANSWER
// round-trip used by the per-card Accept buttons, so the form DOM stays
// in sync.
els.btnAcceptAll.addEventListener('click', () => {
  const pending = state.entries.filter((e) => e.status === 'pending');
  let count = 0;
  pending.forEach((entry) => {
    // Case B: form and image passes both exist and agree - apply once
    // as "verified".
    if (entry.formPass && entry.imagePass) {
      acceptVerified(entry);
      count++;
    } else if (entry.formPass) {
      acceptForm(entry);
      count++;
    } else if (entry.imagePass) {
      acceptImage(entry);
      count++;
    }
  });
  showToast(`Accepting ${count} suggestions`);
  logActivity(`Bulk accept: ${count} entries`);
});

// Refresh button (top bar): re-detect the active page and reset the side
// panel so the user can re-run the flow without reopening the extension.
// Equivalent to closing and re-opening the side panel.
if (els.btnRefresh) {
  els.btnRefresh.addEventListener('click', () => {
    logActivity('Refreshing...');
    // Deliver any un-sent review first. The fetch itself runs in the service
    // worker, so it survives this document being torn down by the reload; if
    // it still fails, the alarm retries from the stored draft.
    if (state.entries.length && state.feedbackSentForResultId !== state.resultId) {
      clearTimeout(draftSaveTimer);
      saveFeedbackDraftNow();
      flushFeedbackDraft('auto_reload');
    }
    location.reload();
  });
}

function focusQuestionInPage(uid) {
  chrome.runtime.sendMessage({ action: 'FOCUS_QUESTION', questionUid: uid }, (resp) => {
    if (!resp?.ok) showToast('Could not locate that question on the page');
  });
}

// ═════════════════════════════════════════════════════════════════════
// 8.10  Feedback submission
// ═════════════════════════════════════════════════════════════════════
//
// After Sync completes, the inspector reviews each AI suggestion and
// either accepts (form / image / verified) or rejects it. The "Send
// Feedback" button at the bottom of the queue card bundles every
// reviewed question into a single payload and POSTs it to FEEDBACK_API
// (the fetch itself lives in background/background.js for mixed-content
// reasons - same as the verify call).
//
// Payload shape (one feedback entry per question shown in the queue):
//
//   {
//     result_id: "<result_id from verify response>",
//     feedback: [
//       {
//         questionId:     "Q123",
//         questionText:   "Year roof was installed?",
//         questionType:   "text",        // inputType from the scrape
//         currentAnswer:  "2015",        // value in the form right now
//         formAnswer:     "2018",        // AI form-pass answer
//         imageAnswer:    "2018",        // AI image-pass answer
//         answerSelected: "2018",        // what the user actually picked
//         reviewStatus:   "accepted-form" // what the reviewer did (below)
//       },
//       ...
//     ]
//   }
//
// answerSelected resolution (matches the entry.status set by the
// Accept/Reject handlers):
//
//   accepted-form     → formAnswer
//   accepted-image    → imageAnswer
//   accepted-verified → formAnswer (verified means form/image agree)
//   rejected          → currentAnswer (form wasn't changed)
//   matched*          → currentAnswer (current already agrees with AI)
//   pending           → currentAnswer (no action taken yet)
//
// reviewStatus carries entry.status verbatim, because answerSelected alone
// can't distinguish the Matched verdicts - all three resolve to
// currentAnswer. Values:
//
//   pending            shown in the queue, never actioned
//   accepted-form | accepted-image | accepted-verified
//                      reviewer applied that pass to the form
//   rejected           reviewer dismissed the suggestion
//   matched            form and AI already agreed; reviewer didn't rule on it
//   matched-correct    reviewer confirmed the agreed value is right
//   matched-incorrect  reviewer says the agreed value is WRONG - i.e. form
//                      and AI were wrong together. This is the one to mine
//                      for questions the AI silently gets wrong.

/**
 * Convert one feedback-relevant answer to the wire shape:
 *   - checkbox: array of label strings
 *   - everything else: string (or empty string)
 */
function feedbackFormatAnswer(question, raw) {
  if (raw == null) return question && question.inputType === 'checkbox' ? [] : '';
  if (question && question.inputType === 'checkbox') {
    if (Array.isArray(raw)) {
      return raw
        .filter((s) => s != null)
        .map((s) => String(s).trim())
        .filter((s) => s !== '');
    }
    const s = String(raw).trim();
    return s ? [s] : [];
  }
  return String(raw).trim();
}

/**
 * Pull the AI form-pass / image-pass answers off an entry, in the wire
 * shape feedbackFormatAnswer produces. Returns '' / [] when the pass is
 * absent so the payload key is always present.
 */
function getPassAnswerForFeedback(entry, which) {
  const pass = which === 'form' ? entry.formPass : entry.imagePass;
  if (!pass) return entry.question.inputType === 'checkbox' ? [] : '';
  return feedbackFormatAnswer(entry.question, pass.aiAnswer);
}

/**
 * Build the answerSelected value for one entry, based on what the user
 * accepted in the UI. Falls back to currentAnswer for rejected / pending
 * / matched entries.
 */
function resolveAnswerSelected(entry, currentAnswer, formAnswer, imageAnswer) {
  switch (entry.status) {
    case 'accepted-form': return formAnswer;
    case 'accepted-image': return imageAnswer;
    case 'accepted-verified': return formAnswer;       // form == image in caseB
    case 'rejected':
    case 'matched':
    case 'matched-correct':
    case 'matched-incorrect':
    case 'pending':
    default: return currentAnswer;   // nothing was written to the form
  }
}

/**
 * Build the full feedback payload from current state. One entry per
 * question that appeared in the queue (i.e. that had an AI suggestion).
 */
function buildFeedbackPayload() {
  const feedback = state.entries.map((entry) => {
    const q = entry.question;
    const currentAnswer = feedbackFormatAnswer(q, q.answer);
    const formAnswer = getPassAnswerForFeedback(entry, 'form');
    const imageAnswer = getPassAnswerForFeedback(entry, 'image');
    const answerSelected = resolveAnswerSelected(
      entry, currentAnswer, formAnswer, imageAnswer
    );
    return {
      questionId: q.questionId || entry.uid,
      questionText: q.questionText || '',
      questionType: q.inputType || '',
      currentAnswer,
      formAnswer,
      imageAnswer,
      answerSelected,
      reviewStatus: entry.status,
    };
  });

  return {
    result_id: state.resultId || '',
    feedback,
  };
}

// ── Draft persistence + ground truth (see common/feedback.js) ────────
//
// Two additions to the feedback path:
//
//   1. Every decision saves a draft, so a review is no longer lost when the
//      panel is closed or Refresh is pressed without clicking Send.
//   2. At send time the live form is RE-SCRAPED, so the payload records what
//      the inspector actually left in the form rather than only what they
//      clicked. An inspector who ignores the panel and types the correct
//      answer straight into the form is now captured.

/** How many entries carry an explicit human decision. */
function countReviewed() {
  return state.entries.filter((e) => e.status && e.status !== 'pending').length;
}

let draftSaveTimer = null;

/** True when there is an un-delivered review worth persisting. */
function hasUnsentReview() {
  if (!window.NSR_FEEDBACK) return false;
  if (!state.entries.length) return false;
  // Already delivered for this run - don't resurrect it.
  return !(state.feedbackSentForResultId && state.feedbackSentForResultId === state.resultId);
}

/** Write the draft immediately. Used when a reload/close is imminent. */
function saveFeedbackDraftNow() {
  if (!hasUnsentReview()) return;
  try {
    chrome.runtime.sendMessage({
      action: 'FEEDBACK_DRAFT',
      draft: {
        payload: buildFeedbackPayload(),
        surveyNumber: state.surveyNumber || null,
        // Recorded so the worker can re-scrape the RIGHT tab later, and skip
        // enrichment if that tab has moved to a different page.
        tabId: state.pipelineTabId ?? null,
        pageKey: state.pipelinePageKey || null,
        reviewedCount: countReviewed(),
        totalCount: state.entries.length,
      },
    }, () => { void chrome.runtime.lastError; });
  } catch (_) { /* ignore */ }
}

/**
 * Persist the in-progress review. Debounced - accepting ten answers in a row
 * should not mean ten storage writes.
 */
function saveFeedbackDraft() {
  if (!hasUnsentReview()) return;
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(saveFeedbackDraftNow, 800);
}

/**
 * Re-read the live form. Returns the extractor's items, or null when the page
 * is no longer available - the payload then declares ground_truth
 * 'unavailable' instead of inventing a value.
 */
function rescrapeForGroundTruth() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    // Don't let a wedged content script block the send indefinitely.
    setTimeout(() => done(null), 4000);
    try {
      chrome.runtime.sendMessage({ action: 'SCRAPE' }, (resp) => {
        if (chrome.runtime.lastError) return done(null);
        done(resp?.success && Array.isArray(resp.items) ? resp.items : null);
      });
    } catch (_) {
      done(null);
    }
  });
}

/**
 * Ask the worker to send the stored draft now. Used by Refresh and by the
 * panel closing - both cases where awaiting a fetch here is not safe.
 */
function flushFeedbackDraft(trigger) {
  try {
    chrome.runtime.sendMessage({ action: 'FEEDBACK_FLUSH', trigger }, () => {
      void chrome.runtime.lastError;
    });
  } catch (_) { /* ignore */ }
}

/**
 * Update the Send Feedback button label without touching disabled state.
 * Used to flash "Sending…" / "Sent" feedback during the round-trip.
 */
function setFeedbackButtonLabel(text) {
  if (!els.btnSendFeedback) return;
  const span = els.btnSendFeedback.querySelector('span');
  if (span) span.textContent = text;
  else els.btnSendFeedback.textContent = text;
}

/**
 * Click handler for the Send Feedback button. Disables itself during the
 * round-trip, surfaces the backend status via toast + activity log, and
 * re-enables on completion (success or error - user can retry on error).
 */
async function sendFeedback() {
  if (state.feedbackSending) return;
  if (!state.entries.length) {
    showToast('Nothing to send - run Sync first');
    return;
  }

  state.feedbackSending = true;
  els.btnSendFeedback.disabled = true;
  setFeedbackButtonLabel('Sending…');

  // Re-read the live form first, so the payload reports what the inspector
  // actually left there. If the page has moved on, `enrichWithGroundTruth`
  // marks the payload 'unavailable' rather than guessing.
  const freshItems = await rescrapeForGroundTruth();

  let payload = buildFeedbackPayload();
  if (window.NSR_FEEDBACK) {
    payload = window.NSR_FEEDBACK.enrichWithGroundTruth(payload, freshItems);
    payload = window.NSR_FEEDBACK.stampProvenance(payload, {
      trigger: 'manual',
      reviewedCount: countReviewed(),
      totalCount: state.entries.length,
    });
  }

  const gt = payload.ground_truth_stats;
  logActivity(
    `Sending feedback for ${payload.feedback.length} question${payload.feedback.length === 1 ? '' : 's'}…`
    + (gt && gt.agreement != null
      ? ` (form check: ${Math.round(gt.agreement * 100)}% of ${gt.compared} match the AI)`
      : freshItems ? '' : ' (form re-read unavailable)')
  );

  chrome.runtime.sendMessage(
    {
      action: 'SEND_FEEDBACK',
      payload,
      // Carried for usage attribution only - the backend payload is unchanged.
      surveyNumber: state.surveyNumber || null,
      trigger: 'manual',
    },
    (resp) => {
      state.feedbackSending = false;
      if (chrome.runtime.lastError || !resp) {
        setFeedbackButtonLabel('Send Feedback');
        els.btnSendFeedback.disabled = false;
        const msg = (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Unknown error';
        showToast(`Feedback failed: ${msg}`);
        logActivity(`Feedback failed: ${msg}`, 'error');
        return;
      }
      if (resp.ok) {
        setFeedbackButtonLabel('Feedback sent ✓');
        // Leave disabled so a single Sync run produces a single feedback
        // POST. Next Sync (or page change) re-enables it.
        els.btnSendFeedback.disabled = true;
        // Drop the draft so the alarm-driven safety net cannot deliver this
        // same review a second time.
        state.feedbackSentForResultId = state.resultId || null;
        clearTimeout(draftSaveTimer);
        try {
          chrome.runtime.sendMessage({ action: 'FEEDBACK_CLEAR' }, () => {
            void chrome.runtime.lastError;
          });
        } catch (_) { /* ignore */ }
        showToast('Feedback sent. Thank you!');
        logActivity(`Feedback sent (${payload.feedback.length} item${payload.feedback.length === 1 ? '' : 's'})`, 'success');
      } else {
        setFeedbackButtonLabel('Send Feedback');
        els.btnSendFeedback.disabled = false;
        const detail = resp.detail || `HTTP ${resp.status || '?'}`;
        showToast(`Feedback failed: ${detail}`);
        logActivity(`Feedback failed: ${detail}`, 'error');
      }
    }
  );
}

if (els.btnSendFeedback) {
  els.btnSendFeedback.addEventListener('click', sendFeedback);
}

// ═════════════════════════════════════════════════════════════════════
// 9. Image-extraction subsystem
// ═════════════════════════════════════════════════════════════════════

function showImgStatusWarning(title, bodyHtml) {
  els.imgStatusTitle.textContent = title;
  els.imgStatusBody.innerHTML = bodyHtml;
  els.imgStatusCard.style.display = 'block';
}

function hidePhotoUi() {
  els.imgToolbarCard.style.display = 'none';
  els.imgGalleryCard.style.display = 'none';
  els.imgFooter.style.display = 'none';
}

function showPhotoUi() {
  els.imgToolbarCard.style.display = 'block';
  els.imgGalleryCard.style.display = 'block';
  els.imgFooter.style.display = 'block';
  els.imgStatusCard.style.display = 'none';
}

function extractImages() {
  if (state.isImagesProcessing) return;
  showImgProgress('Extracting images…', '', 0, 1, 'Connecting to page…');

  chrome.runtime.sendMessage({ action: 'EXTRACT_IMAGES' }, (resp) => {
    hideImgProgress();
    if (chrome.runtime.lastError) return failExtract('Could not connect to the page. Make sure you\'re on an LC360 survey page.');
    if (!resp) return failExtract('No response from content script. Try refreshing the LC360 page.');
    if (resp.error === 'NOT_ORDER_PHOTOS_PAGE') {
      if (resp.meta) updateImgMeta(resp.meta);
      hidePhotoUi();
      showImgStatusWarning(
        'Order Photos panel not open',
        resp.reason
          || 'Click <strong>ORDER</strong> above the photo rail to open the '
             + '<strong>Order/Edit Photos</strong> panel.'
      );
      return;
    }
    if (resp.error) return failExtract(resp.error);
    if (!resp.images || resp.images.length === 0) return failExtract('No images found on this page.');

    state.images = resp.images;
    state.imgMeta = resp.meta;
    state.currentSort = 'original';

    // Preserve prior AI verification when re-extracting the SAME photo set.
    // extractImages() runs automatically every time the user returns to the
    // Order Photos page (e.g. after the results tab opened), so blindly
    // clearing apiResults here would grey out the AI Sort button and drop
    // the per-image label choices. We only invalidate when the set of
    // photoIds on the page has genuinely changed.
    const newIds = resp.images.map((i) => i.photoId).sort().join('|');
    const aiIds = state.apiResults
      ? Object.keys(state.aiLabelById).sort().join('|')
      : '';
    const sameSet = state.apiResults && newIds !== '' && newIds === aiIds;

    if (!sameSet) {
      // Different (or first) photo set → prior verification no longer applies.
      state.apiResults = null;
      state.labelChoice = {};
      state.aiLabelById = {};
      state.origLabelById = {};
      // …and the prefetched blobs belong to the old set - drop them.
      clearImgBlobCache();
    }

    if (resp.meta) updateImgMeta(resp.meta);
    updateSortButtons(state.currentSort);
    showPhotoUi();
    renderGallery(state.images);
    logActivity(`Extracted ${state.images.length} image${state.images.length === 1 ? '' : 's'}`, 'success');

    // Warm the cache in the background so the "Display Description" click is
    // near-instant. Safe to call on every extract: it re-warms only the gaps
    // (already-cached photos are skipped) and is bounded by the byte budget.
    startImgPrefetch();
  });
}

function failExtract(message) {
  hidePhotoUi();
  showImgStatusWarning('Extraction failed', escapeHtml(message));
  logActivity(`Image extract failed: ${message}`, 'error');
}

/**
 * Resolve the current per-image label choices into a { photoId: label }
 * map the content script can apply. Only photos that have an AI result
 * appear here; everything else is left untouched on the page.
 *
 *   choice 'ai'       → AI verifiedLabel
 *   choice 'original' → original label captured at verify time
 */
function buildLabelMap() {
  const map = {};
  Object.keys(state.labelChoice || {}).forEach((photoId) => {
    const choice = state.labelChoice[photoId];
    map[photoId] = (choice === 'ai')
      ? (state.aiLabelById[photoId] || '')
      : (state.origLabelById[photoId] || '');
  });
  return map;
}

function applyApiSort() {
  if (state.isImagesProcessing || !state.apiResults) return;
  showImgProgress('Applying AI sort...', '', 0, 1, 'Reordering on page…');

  chrome.runtime.sendMessage(
    { action: 'APPLY_API_RESULTS', results: state.apiResults, labelMap: buildLabelMap() },
    (resp) => {
      hideImgProgress();
      if (chrome.runtime.lastError || !resp) return showToast('Failed to apply AI sort');
      if (resp.error) return showToast('Error: ' + resp.error);
      if (resp.images) {
        state.images = resp.images;
        state.currentSort = 'api';
        updateSortButtons('api');
        renderGallery(state.images);
        showToast('AI sort applied.');
        logActivity('Applied AI sort to page', 'success');
      }
    }
  );
}

function applyOriginalSort() {
  if (state.isImagesProcessing) return;
  showImgProgress('Restoring original…', '', 0, 1, 'Restoring original order…');

  // Pass the resolved label map so per-image choices survive the order
  // change. When no AI verification has happened, labelMap is empty and the
  // content script falls back to the original-snapshot labels.
  const labelMap = state.apiResults ? buildLabelMap() : null;

  chrome.runtime.sendMessage({ action: 'RESTORE_IMAGES', labelMap }, (resp) => {
    hideImgProgress();
    if (chrome.runtime.lastError || !resp) return showToast('Failed to restore original');
    if (resp.error) return showToast('Error: ' + resp.error);
    if (resp.images) {
      state.images = resp.images;
      state.currentSort = 'original';
      updateSortButtons('original');
      renderGallery(state.images);
      showToast('Original order restored');
      logActivity('Restored original order', 'success');
    }
  });
}

function updateSortButtons(activeSort) {
  els.btnSortOrig.classList.toggle('is-active', activeSort === 'original');
  els.btnSortApi.classList.toggle('is-active', activeSort === 'api');
  if (state.apiResults) {
    els.btnSortApi.disabled = false;
    els.btnSortApi.classList.remove('is-disabled');
  } else {
    els.btnSortApi.disabled = true;
    els.btnSortApi.classList.add('is-disabled');
  }
}

// ── Image-verify backend endpoint ─────────────────────────────────────
// Sent as multipart/form-data with:
//   · "data"  → JSON-stringified ARRAY of { photoId, label, order } (one per
//               image, in current on-page order). NOT wrapped in an object -
//               the backend rejects the wrapped form.
//   · "files" → one part per successfully-fetched image blob, filename =
//               "<photoId>.jpg". Failed fetches are silently skipped (the
//               metadata entry is still sent so the backend sees the gap).
// Same host under a /test prefix; production is https://qagent.dhaninfo.ai/pipeline.
// NOTE: deliberately out of step with background.js's API_BASE, which is still
// on production - only the image pipeline is pointed at staging. Move both when
// the rest of the QA Agent flows follow.
const IMAGES_API = 'https://qagent.dhaninfo.ai/test/pipeline';

/**
 * Report an image batch to the LMS licence meter, swallowing every failure.
 *
 * Wraps common/lmsUsage.js so the upload path has exactly one line to call and
 * no error handling of its own. The four ways this can fail - module missing,
 * not signed in, a session with no license_id, the LMS being unreachable - all
 * end the same way: a console note and an upload that proceeds regardless.
 *
 * Returns the quota standing on success so a caller could show it; the upload
 * path ignores it by design (per project decision: record and continue, never
 * block on quota).
 */
async function reportImageUsageSafely(imageCount) {
  try {
    if (!window.NSR_LMS_USAGE) return null;
    const res = await window.NSR_LMS_USAGE.reportImageUsage(imageCount);
    if (res && res.ok) {
      console.log(
        `[SmartFill] Metered ${imageCount} image(s): ` +
        `${res.consumed}/${res.max} used, ${res.remaining} remaining`
      );
      return res;
    }
    console.warn('[SmartFill] Image usage not recorded:', res && (res.detail || res.kind));
    return null;
  } catch (err) {
    console.warn('[SmartFill] Image usage reporting threw:', err);
    return null;
  }
}

/**
 * The licence id this install currently holds, or '' when there isn't one.
 *
 * Read from the stored session rather than captured earlier, so it reflects
 * whatever ensureLicense() last confirmed on panel open - a device can be
 * handed a different licence between launches (old one revoked, a new one
 * auto-assigned from the pool), and the pipeline should hear about the licence
 * actually in hand.
 *
 * Returns '' rather than throwing for the same reason reportImageUsageSafely
 * swallows its failures: the upload must not depend on the licence layer.
 */
async function currentLicenseId() {
  try {
    const session = await window.NSR_AUTH?.getSession();
    return (session && session.license_id) || '';
  } catch (_) {
    return '';
  }
}

// ── Full-res blob prefetch ─────────────────────────────────────────────
// The operator almost always clicks "Display Description" after reviewing the
// gallery, so we speculatively download full-res blobs right after extract and
// keep them in state.imgBlobCache. When the button is clicked the download step
// then reads mostly from cache and finishes near-instantly.
//
// Memory guard: a 200-photo survey at ~3 MB each would be ~600 MB, so retained
// bytes are capped at PREFETCH_BUDGET_BYTES. Past the cap prefetch stops; the
// click path still fetches the remainder on demand (it has to load every blob
// for the upload FormData anyway - the cap only bounds the *speculative*
// portion held before the click). The cache is invalidated whenever the
// on-page photo set changes (see extractImages / clearImgBlobCache).
const PREFETCH_BUDGET_BYTES = 250 * 1024 * 1024; // 250 MB retained ceiling
const PREFETCH_CONCURRENCY = 6;

/**
 * Return { blob, filename } for one image, from cache when possible. Dedupes
 * concurrent asks for the same photoId via an in-flight map, and retains the
 * result only while under the byte budget AND the photo is still part of the
 * current on-page set (guards a fetch that resolves after the set changed).
 * Rejects if the underlying fetch fails - callers decide whether that's an
 * upload sentinel or a silent prefetch skip.
 */
function getOrFetchBlob(img, targetTabId) {
  const pid = img.photoId;
  const cached = state.imgBlobCache.get(pid);
  if (cached) return Promise.resolve(cached);
  const pending = state.imgBlobInFlight.get(pid);
  if (pending) return pending;

  const p = fetchImageBlob(img.fullResUrl, targetTabId).then((blobData) => {
    const entry = { blob: blobData.blob, filename: pid + '.jpg' };
    const size = (blobData.blob && blobData.blob.size) || 0;
    const stillCurrent = state.images.some((x) => x.photoId === pid);
    if (stillCurrent && state.imgBlobCacheBytes + size <= PREFETCH_BUDGET_BYTES) {
      state.imgBlobCache.set(pid, entry);
      state.imgBlobCacheBytes += size;
    }
    state.imgBlobInFlight.delete(pid);
    return entry;
  }).catch((err) => {
    state.imgBlobInFlight.delete(pid);
    throw err;
  });

  state.imgBlobInFlight.set(pid, p);
  return p;
}

/**
 * Drop every cached blob and cancel any running prefetch. Called when the
 * on-page photo set changes (different survey / photos added or removed) so
 * stale bytes are never uploaded or counted against the budget.
 */
function clearImgBlobCache() {
  state.imgPrefetchToken++;      // stale-out any in-progress prefetch run
  state.imgBlobCache.clear();
  state.imgBlobInFlight.clear();
  state.imgBlobCacheBytes = 0;
}

/**
 * Fire-and-forget speculative download of the current images into the cache.
 * Bounded to PREFETCH_CONCURRENCY workers; stops early when the byte budget is
 * reached, the token is superseded (newer prefetch / cache clear / an active
 * Display-Description run), or the images run out. Failures are swallowed - the
 * click path will retry and surface them.
 */
function startImgPrefetch() {
  const targetTabId = state.detection && state.detection.tabId;
  if (typeof targetTabId !== 'number' || state.images.length === 0) return;

  const token = ++state.imgPrefetchToken;
  const images = state.images.slice();
  let nextIdx = 0;

  const worker = async () => {
    for (;;) {
      if (token !== state.imgPrefetchToken) return;                 // superseded
      if (state.imgBlobCacheBytes >= PREFETCH_BUDGET_BYTES) return; // budget hit
      const i = nextIdx++;
      if (i >= images.length) return;
      const img = images[i];
      if (state.imgBlobCache.has(img.photoId)) continue;            // already warm
      try { await getOrFetchBlob(img, targetTabId); }
      catch (_) { /* click path retries/reports */ }
    }
  };

  // Fire-and-forget: the operator keeps reviewing the gallery while this runs.
  Promise.all(
    Array.from({ length: Math.min(PREFETCH_CONCURRENCY, images.length) }, worker)
  ).catch(() => {});
}

async function displayDescriptions() {
  if (state.isImagesProcessing || state.images.length === 0) return;

  // Pin the LC360 tab id NOW, before any async work begins. The user is
  // free to switch tabs while the loop runs (some users do this deliberately
  // to check email while ~50 images upload); without a pinned target the
  // service worker would route each fetch to whichever tab is currently
  // focused, which fails.
  const targetTabId = state.detection?.tabId;
  if (typeof targetTabId !== 'number') {
    showToast('Cannot start: no LC360 tab detected. Reopen the side panel on the Order Photos page.');
    logActivity('Display Description aborted: no tab id pinned', 'error');
    return;
  }

  // The pipeline keys the batch on survey_number, so an upload without one is
  // orphaned on arrival - and the old code appended '' rather than omitting
  // the field, which made that look like a successful run. content.js
  // withSurveyIdentity() now backfills the number from the page when the
  // DynForms engine isn't loaded; this stops the upload outright if every
  // source still comes back empty, instead of failing quietly downstream.
  const surveyNumber = state.imgMeta?.surveyNumber || '';
  if (!surveyNumber) {
    showToast('Cannot start: no survey number found on this page. Open Order Photos from the survey and try again.');
    logActivity('Display Description aborted: survey number missing from photo panel metadata', 'error');
    return;
  }

  state.isImagesProcessing = true;
  els.btnDescribe.disabled = true;

  // Halt the background prefetch pool so it doesn't compete with this download
  // for the 6-worker budget. The loop below now drives everything - reading
  // cache hits instantly and fetching only whatever prefetch didn't reach.
  state.imgPrefetchToken++;

  const total = state.images.length;
  const imageBlobs = []; // { photoId, label, blob | null, filename }

  try {
    // ── Step 1: fetch each full-res blob through the content script ──
    // (cookies on the LC360 origin are required to authorise the request,
    //  so we route through the page rather than fetching directly here)
    showImgProgress('Fetching images…', `0 / ${total}`, 0, total, 'Downloading full-resolution images…');

    // Bounded-concurrency download pool. A serial loop makes total time the SUM
    // of every image's round-trip; with ~50 photos that dominates the flow. We
    // run CONCURRENCY workers that each pull the next un-claimed index, so up to
    // CONCURRENCY fetches are in flight at once. We DON'T fire all `total` at
    // once - that floods the LC360 origin and the extension messaging channel.
    //
    // Results are written to imageBlobs[i] by index (not push()) so the array
    // keeps on-page order even though downloads now finish out of order - the
    // backend's per-image `order` field depends on that ordering.
    const CONCURRENCY = 6;
    imageBlobs.length = total; // pre-size; workers fill by index
    let completed = 0;
    let next = 0;

    const worker = async () => {
      for (;;) {
        const i = next++;            // claim an index
        if (i >= total) return;
        const img = state.images[i];
        try {
          // Reads from the prefetch cache when warm; otherwise downloads now
          // (routed through the LC360 tab via targetTabId for its cookies).
          const entry = await getOrFetchBlob(img, targetTabId);
          imageBlobs[i] = {
            photoId: img.photoId,
            label: img.label,
            blob: entry.blob,
            filename: entry.filename,
          };
        } catch (err) {
          console.error('[SmartFill] Failed to fetch image:', img.label, err);
          // Sentinel so the metadata array still includes this entry - it just
          // won't have a corresponding `files` part.
          imageBlobs[i] = {
            photoId: img.photoId,
            label: img.label,
            blob: null,
            filename: img.photoId + '.jpg',
            error: err.message,
          };
        }
        // Progress counts COMPLETIONS, not a loop index - downloads no longer
        // finish in order.
        completed++;
        updateImgProgress(
          'Fetching images…',
          `${completed} / ${total}`,
          completed, total,
          `Downloaded ${completed} of ${total}`
        );
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, total) }, worker)
    );

    // ── Step 2: build the multipart body ─────────────────────────────
    updateImgProgress('Preparing upload...', '', total, total, 'Building request payload...');

    const formData = new FormData();

    // The backend expects:
    //   · `data` -> JSON-stringified ARRAY of { photoId, label, order }
    //     (one per image, in current on-page order). NOT wrapped in an object.
    //   · `survey_number` -> separate top-level form field.
    const metadata = imageBlobs.map((item, index) => ({
      photoId: item.photoId,
      label: item.label,
      order: index,
    }));
    formData.append('data', JSON.stringify(metadata));
    formData.append('survey_number', surveyNumber);   // guarded non-empty above
    formData.append('survey_type', state.imgMeta?.surveyType || '');

    // The LMS licence this batch belongs to - the same UUID sent to
    // POST /external/usage a few lines below, so the pipeline's record and the
    // meter's record can be reconciled against each other. Sent as '' when
    // there is no session, or when an older session predates license_id:
    // quota is a meter and not a gate here either, so a missing licence must
    // not cost the inspector their upload.
    formData.append('license_id', await currentLicenseId());

    // One `files` part per successfully-fetched blob. Filename uses .jpg
    // even if the backend mime-sniffs internally - the original extension
    // does the same and the backend accepts it.
    imageBlobs.forEach((item) => {
      if (item.blob) {
        formData.append('files', item.blob, item.filename);
      }
    });

    // ── Step 3: POST to the pipeline ─────────────────────────────────
    // Surface the count here so the inspector sees exactly how many images
    // are about to be sent. `validCount` ignores entries whose blob fetch
    // failed (sentinels with blob === null); the metadata array still
    // includes them, but they have no `files` part attached.
    const validCount = imageBlobs.filter((it) => it.blob).length;
    const countLabel = `${validCount} of ${total} image${total === 1 ? '' : 's'}`;
    updateImgProgress(
      'Processing…',
      countLabel,
      total, total,
      `Uploading ${countLabel} and metadata…`
    );

    // ── Meter this batch against the licence (guide §8) ──────────────
    // Sent BEFORE the upload, so the count reflects what is about to be
    // processed. Deliberately not awaited into the critical path's success:
    // quota is a meter, not a gate, and a metering failure must never cost
    // the inspector their photo upload. Failures are logged, not surfaced.
    await reportImageUsageSafely(validCount);

    const response = await fetch(IMAGES_API, {
      method: 'POST',
      body: formData,
      // No Content-Type header - fetch sets the correct multipart boundary
      // automatically when given a FormData body.
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`API returned HTTP ${response.status}${errText ? ': ' + errText.substring(0, 200) : ''}`);
    }

    const apiResult = await response.json();
    state.apiResults = apiResult.results || [];

    // Build the per-image label-choice model now that AI labels exist.
    // Default rule: choose 'ai' only where the AI label differs from the
    // original; otherwise 'original'. Choices persist across sort toggles.
    state.aiLabelById = {};
    state.origLabelById = {};
    state.labelChoice = {};
    const origByIdNow = {};
    state.images.forEach((img) => { origByIdNow[img.photoId] = img.label || ''; });
    state.apiResults.forEach((r) => {
      if (!r || !r.photoId) return;
      const aiLabel = (r.verifiedLabel != null) ? String(r.verifiedLabel) : '';
      const origLabel = origByIdNow[r.photoId] != null ? String(origByIdNow[r.photoId]) : '';
      state.aiLabelById[r.photoId] = aiLabel;
      state.origLabelById[r.photoId] = origLabel;
      const differs = aiLabel.trim() !== origLabel.trim() && aiLabel.trim() !== '';
      state.labelChoice[r.photoId] = differs ? 'ai' : 'original';
    });

    updateSortButtons(state.currentSort);

    // Apply the default per-image label choices to the page WITHOUT changing
    // the current order (photos defaulted to 'ai' get the AI label written;
    // 'original' ones are left as-is). Then re-render the gallery so the
    // AI/Original toggles appear. Order stays put until the user presses a
    // sort button - labels and order are independent now.
    const defaultLabelMap = buildLabelMap();
    chrome.runtime.sendMessage(
      { action: 'SET_IMAGE_LABELS_BULK', labelMap: defaultLabelMap },
      (resp) => {
        if (!chrome.runtime.lastError && resp && resp.images) {
          state.images = resp.images;
        }
        renderGallery(state.images);
      }
    );

    const resultsData = {
      meta: state.imgMeta || {},
      results: state.apiResults,
      thumbnails: {},
    };
    state.images.forEach((img) => {
      resultsData.thumbnails[img.photoId] = img.thumbnailUrl;
      resultsData.thumbnails[img.photoId + '_full'] = img.fullResUrl;
    });

    // ── Step 4: open the results report ──────────────────────────────
    // We do this from the side panel directly (not via the service worker)
    // so the message-port lifecycle can't tear down the worker mid-flight
    // before chrome.tabs.create resolves. The side panel has the same
    // chrome.tabs/storage privileges as the worker.
    await openResultsTab(resultsData);

    hideImgProgress();
    showToast('Results ready. AI Sort is now available.');
    logActivity(
      `Image verification complete: ${state.apiResults.length} result${state.apiResults.length === 1 ? '' : 's'}`,
      'success'
    );
  } catch (err) {
    hideImgProgress();
    showToast('API error: ' + err.message);
    logActivity('Image verification failed: ' + err.message, 'error');
    console.error('[SmartFill] Images pipeline failed:', err);
  } finally {
    state.isImagesProcessing = false;
    els.btnDescribe.disabled = false;
  }
}

/**
 * Open the results report in a new browser tab placed immediately to the
 * right of the user's current LC360 tab. The payload is stashed in
 * chrome.storage.local under a unique key whose name is passed as the URL
 * fragment - results.js picks it up on DOMContentLoaded and deletes the
 * entry so a refresh doesn't redraw stale data.
 *
 * Runs from the side panel context directly so MV3 service-worker tear-down
 * mid-async-flow can't interrupt the open.
 */
async function openResultsTab(resultsData) {
  const key = 'results:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8);

  try {
    await chrome.storage.local.set({ [key]: resultsData });

    // Find the user's current tab so we can place the new one right after.
    // `currentWindow: true` is the side panel's containing window - i.e.
    // the same window the user is looking at.
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    const createOpts = {
      url: chrome.runtime.getURL('results/results.html') + '#' + encodeURIComponent(key),
      active: true,
    };
    if (activeTab && typeof activeTab.index === 'number') {
      createOpts.index = activeTab.index + 1;
      createOpts.openerTabId = activeTab.id;
    }
    if (activeTab && typeof activeTab.windowId === 'number') {
      createOpts.windowId = activeTab.windowId;
    }

    await chrome.tabs.create(createOpts);
  } catch (err) {
    console.error('[SmartFill] Failed to open results tab:', err);
    showToast('Could not open results tab: ' + err.message);
    // Make sure the stashed payload doesn't leak if the tab open failed
    chrome.storage.local.remove(key).catch(() => { });
    throw err;
  }
}


/**
 * Ask the content script to fetch an image (so the page's session cookies
 * are sent), then reconstruct the Blob on this side. Returns { blob, type,
 * size } - matching the shape the old extension's pipeline expected.
 *
 * `targetTabId` pins the request to the LC360 tab captured when the user
 * started the operation. Without it, the service worker would route to
 * whichever tab the user is *currently* looking at, which fails the moment
 * they switch tabs mid-loop.
 */
function fetchImageBlob(imageUrl, targetTabId) {
  return new Promise((resolve, reject) => {
    const msg = { action: 'FETCH_IMAGE_BLOB', imageUrl };
    if (typeof targetTabId === 'number') msg.targetTabId = targetTabId;
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (!response || response.error) {
        return reject(new Error(response ? response.error : 'No response'));
      }

      // dataUrl → Blob (the content script handed us a base64 data URL because
      // raw Blobs can't be serialised across runtime.sendMessage).
      try {
        const commaIdx = response.dataUrl.indexOf(',');
        const byteString = atob(response.dataUrl.substring(commaIdx + 1));
        const mimeType = response.type || 'image/jpeg';
        const ab = new ArrayBuffer(byteString.length);
        const ia = new Uint8Array(ab);
        for (let j = 0; j < byteString.length; j++) ia[j] = byteString.charCodeAt(j);
        const blob = new Blob([ab], { type: mimeType });
        resolve({ blob, type: mimeType, size: response.size });
      } catch (err) {
        reject(new Error('Failed to decode image data: ' + err.message));
      }
    });
  });
}

// ── Image-pipeline progress UI ──────────────────────────────────────

function showImgProgress(label, count, current, total, detail) {
  els.imgProgressCard.style.display = 'block';
  updateImgProgress(label, count, current, total, detail);
}
function updateImgProgress(label, count, current, total, detail) {
  els.imgProgressLabel.textContent = label;
  els.imgProgressCount.textContent = count;
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  els.imgProgressBar.style.width = pct + '%';
  els.imgProgressDetail.textContent = detail;
}
function hideImgProgress() {
  els.imgProgressCard.style.display = 'none';
  els.imgProgressBar.style.width = '0%';
}

// ── Gallery rendering + filter ──────────────────────────────────────

/**
 * Record the photo-set metadata.
 *
 * Nothing is rendered: the Survey / Insured / Policy card was removed from the
 * Order Photos view. The data is still kept because it feeds survey_number and
 * survey_type into the image-verify upload and the results page.
 */
function updateImgMeta(meta) {
  state.imgMeta = meta;
}

function renderGallery(images) {
  els.imgGallery.innerHTML = '';
  els.imgCount.textContent = images.length;

  images.forEach((img, idx) => {
    // `img.label` is the raw textbox value (possibly ""). We show
    // "(No label)" in the UI when it's empty, but never persist that
    // placeholder anywhere - so a later Restore writes "" back into the
    // input instead of the literal "(No label)" string.
    const displayLabel = labelForDisplay(img.label);

    // Does this photo have an AI result? Only then do we show the toggle
    // and the Original-vs-AI comparison.
    const hasAi = !!(state.apiResults &&
      Object.prototype.hasOwnProperty.call(state.aiLabelById, img.photoId));
    const choice = state.labelChoice[img.photoId] || 'original';

    const card = document.createElement('div');
    card.className = 'image-card';
    card.setAttribute('title', displayLabel);

    const idHtml = `<div class="card-id">${escapeHtml((img.photoId || '').substring(0, 18))}${img.photoId && img.photoId.length > 18 ? '…' : ''}</div>`;

    let infoHtml;
    if (hasAi) {
      // Show BOTH labels so the operator sees exactly what each choice
      // writes. The currently-selected one is highlighted.
      const origText = labelForDisplay(state.origLabelById[img.photoId]);
      const aiText = labelForDisplay(state.aiLabelById[img.photoId]);
      infoHtml = `
        <div class="card-info">
          <div class="label-compare">
            <div class="label-row ${choice === 'original' ? 'is-chosen' : ''}" data-role="row-original">
              <span class="label-tag tag-original">Original</span>
              <span class="label-val">${escapeHtml(origText)}</span>
            </div>
            <div class="label-row ${choice === 'ai' ? 'is-chosen' : ''}" data-role="row-ai">
              <span class="label-tag tag-ai">AI</span>
              <span class="label-val">${escapeHtml(aiText)}</span>
            </div>
          </div>
          ${idHtml}
        </div>
      `;
    } else {
      // No AI result yet → single current label, as before.
      infoHtml = `
        <div class="card-info">
          <div class="card-label">${escapeHtml(displayLabel)}</div>
          ${idHtml}
        </div>
      `;
    }

    const toggleHtml = hasAi ? `
      <div class="label-toggle" data-role="label-toggle" title="Choose which label to write on the page">
        <button class="lt-opt ${choice === 'original' ? 'is-active' : ''}" data-choice="original">Original</button>
        <button class="lt-opt ${choice === 'ai' ? 'is-active' : ''}" data-choice="ai">AI</button>
      </div>
    ` : '';

    card.innerHTML = `
      <span class="card-index">${idx + 1}</span>
      <div class="card-thumb" data-role="thumb" title="Click to open full resolution">
        <img src="${escapeHtml(img.thumbnailUrl)}" alt="${escapeHtml(displayLabel)}" loading="lazy" />
      </div>
      ${infoHtml}
      ${toggleHtml}
    `;

    // Clicking the mini image (thumbnail) opens the on-page modal (zoom/pan)
    // as a gallery of ALL photos in the current on-page order, starting at
    // this one. `images` is the array this render was given (filtered or
    // full), so the gallery matches exactly what's on screen.
    const thumb = card.querySelector('[data-role="thumb"]');
    if (thumb) {
      thumb.addEventListener('click', (e) => {
        e.stopPropagation();
        const gallery = images.map((im) => im.fullResUrl).filter(Boolean);
        // Resolve the start position by URL so it stays correct even if some
        // photo lacked a full-res URL and got filtered out above.
        const start = Math.max(0, gallery.indexOf(img.fullResUrl));
        openImageOnPage(gallery, start);
      });
    }

    // Per-image label toggle: flipping writes the chosen label to the page
    // immediately and updates the displayed label. Stops propagation so it
    // doesn't also trigger the focus-in-page click below.
    const toggle = card.querySelector('[data-role="label-toggle"]');
    if (toggle) {
      toggle.querySelectorAll('.lt-opt').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const newChoice = btn.dataset.choice; // 'ai' | 'original'
          if (state.labelChoice[img.photoId] === newChoice) return;
          setLabelChoice(img.photoId, newChoice, card);
        });
      });
    }

    // Clicking anywhere else on the card scrolls the matching photo block
    // into the center of the page and flashes a highlight on it - the same
    // behavior as clicking a question card in the Core Revised flow.
    card.addEventListener('click', () => {
      focusImageInPage(img.photoId);
    });

    els.imgGallery.appendChild(card);
  });
}

/**
 * Flip a single photo's label choice ('ai' | 'original'), write the chosen
 * label to the page input via the content script, and update the card UI in
 * place (toggle highlight + displayed label). The choice persists in
 * state.labelChoice so it survives sort toggles.
 */
function setLabelChoice(photoId, choice, card) {
  state.labelChoice[photoId] = choice;
  const newLabel = (choice === 'ai')
    ? (state.aiLabelById[photoId] || '')
    : (state.origLabelById[photoId] || '');

  // Update toggle highlight + which comparison row is chosen (optimistic).
  if (card) {
    card.querySelectorAll('.lt-opt').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.choice === choice);
    });
    const rowOrig = card.querySelector('[data-role="row-original"]');
    const rowAi = card.querySelector('[data-role="row-ai"]');
    if (rowOrig) rowOrig.classList.toggle('is-chosen', choice === 'original');
    if (rowAi) rowAi.classList.toggle('is-chosen', choice === 'ai');
    // Fallback for the no-AI single-label layout (shouldn't occur here,
    // but keeps the function safe if called on a plain card).
    const labelEl = card.querySelector('.card-label');
    if (labelEl) labelEl.textContent = labelForDisplay(newLabel);
  }

  // Keep state.images in sync so re-renders (filter/sort) show the choice.
  const imgRef = state.images.find((i) => i.photoId === photoId);
  if (imgRef) imgRef.label = newLabel;

  chrome.runtime.sendMessage(
    { action: 'SET_IMAGE_LABEL', photoId, label: newLabel },
    (resp) => {
      if (chrome.runtime.lastError || !resp?.ok) {
        showToast('Could not update label on the page');
        return;
      }
      logActivity(`Label set to ${choice === 'ai' ? 'AI' : 'original'} for one photo`);
    }
  );
}

/**
 * Ask the content script to scroll the photo block (matching photoId) to
 * the center of the page and flash a highlight on it. Mirrors
 * focusQuestionInPage used by the form-review flow.
 */
function focusImageInPage(photoId) {
  if (!photoId) return;
  chrome.runtime.sendMessage({ action: 'FOCUS_IMAGE', photoId }, (resp) => {
    if (chrome.runtime.lastError) return;
    if (!resp?.ok) showToast('Could not locate that photo on the page');
  });
}

// UI-only display fallback. The underlying data keeps `label` raw (possibly
// empty) so writes back into the page input are correct.
function labelForDisplay(label) {
  const s = (label == null ? '' : String(label)).trim();
  return s === '' ? '(No label)' : s;
}

function filterImages() {
  const query = (els.imgSearch.value || '').toLowerCase().trim();
  if (!query) { renderGallery(state.images); return; }
  const filtered = state.images.filter((img) =>
    (img.label || '').toLowerCase().includes(query)
  );
  if (filtered.length === 0) {
    els.imgGallery.innerHTML = '<div class="no-filter-results">No images match your filter.</div>';
    els.imgCount.textContent = '0';
  } else {
    renderGallery(filtered);
  }
}

function copyToClipboard(text, toastMsg) {
  navigator.clipboard.writeText(text)
    .then(() => showToast(toastMsg || 'Copied'))
    .catch(() => showToast('Copy failed'));
}

// Image subsystem event wiring
els.btnDescribe.addEventListener('click', displayDescriptions);
els.btnSortOrig.addEventListener('click', () => {
  if (state.isImagesProcessing) return;
  applyOriginalSort();
});
els.btnSortApi.addEventListener('click', () => {
  if (state.isImagesProcessing || !state.apiResults) return;
  applyApiSort();
});
els.imgSearch.addEventListener('input', filterImages);

// ═════════════════════════════════════════════════════════════════════
// 10. Activity log rendering
// ═════════════════════════════════════════════════════════════════════

function renderActivity() {
  if (state.activity.length === 0) {
    els.activityList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="1.6"
               stroke-linecap="round" stroke-linejoin="round">
            <rect x="4" y="3" width="16" height="18" rx="2"/>
            <line x1="8" y1="8" x2="16" y2="8"/>
            <line x1="8" y1="12" x2="16" y2="12"/>
            <line x1="8" y1="16" x2="13" y2="16"/>
          </svg>
        </div>
        <p>No activity yet</p>
        <span>Events will appear here as you sync forms.</span>
      </div>`;
    return;
  }
  els.activityList.innerHTML = state.activity.map((a) => {
    const time = a.ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `
      <div class="activity-item is-${a.level || 'info'}">
        <span class="activity-time">${time}</span>
        <span class="activity-message">${escapeHtml(a.message)}</span>
      </div>`;
  }).join('');
}

els.btnClearLog.addEventListener('click', () => {
  state.activity = [];
  renderActivity();
});

// ═════════════════════════════════════════════════════════════════════
// 10.1  Config: answer-block colour pickers
// ═════════════════════════════════════════════════════════════════════
//
// Three pickers let the user override the soft tint of the Page/Form,
// AI-suggestion (image), and Current answer blocks. The chosen colours
// are persisted to chrome.storage.local under `answerBlockColors` and
// applied immediately by overwriting the corresponding CSS custom
// properties on :root, so the suggestion queue retints live.

const DEFAULT_BLOCK_COLORS = {
  form: '#eef0fe',
  image: '#fbe9fe',
  current: '#f6f7fb',
};

const COLOR_VAR = {
  form: '--cfg-form-bg',
  image: '--cfg-image-bg',
  current: '--cfg-current-bg',
};

function applyBlockColor(target, value) {
  if (!value) return;
  document.documentElement.style.setProperty(COLOR_VAR[target], value);

  // Keep the swatch + picker visually in sync
  const swatch = { form: els.swatchForm, image: els.swatchImage, current: els.swatchCurrent }[target];
  if (swatch) swatch.style.background = value;

  const picker = { form: els.cfgColorForm, image: els.cfgColorImage, current: els.cfgColorCurrent }[target];
  if (picker && picker.value.toLowerCase() !== value.toLowerCase()) {
    picker.value = value;
  }
}

function persistBlockColors() {
  const colors = {
    form: els.cfgColorForm.value,
    image: els.cfgColorImage.value,
    current: els.cfgColorCurrent.value,
  };
  try {
    chrome.storage.local.set({ answerBlockColors: colors }).catch(() => { });
  } catch (_) { /* ignore - storage unavailable */ }
}

// ── Theme toggle (light default, dark opt-in) ─────────────────────────
// Setting data-theme="dark" on <html> activates the :root[data-theme="dark"]
// rules in sidepanel.css. Persisted in chrome.storage and mirrored to
// localStorage so the inline <head> script can apply it before first paint.
function applyTheme(theme) {
  const dark = theme === 'dark';
  const root = document.documentElement;
  if (dark) root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');
  try { localStorage.setItem('sf-theme', dark ? 'dark' : 'light'); } catch (_) { /* non-fatal */ }
  if (els.cfgDark) els.cfgDark.checked = dark;
}

function initThemeToggle() {
  try {
    chrome.storage.local.get('sfTheme').then((res) => {
      applyTheme((res && res.sfTheme) === 'dark' ? 'dark' : 'light');
    }).catch(() => applyTheme('light'));
  } catch (_) { applyTheme('light'); }

  if (els.cfgDark) {
    els.cfgDark.addEventListener('change', () => {
      const theme = els.cfgDark.checked ? 'dark' : 'light';
      applyTheme(theme);
      try { chrome.storage.local.set({ sfTheme: theme }).catch(() => { }); } catch (_) { /* ignore */ }
    });
  }
}

function initColorPickers() {
  if (!els.cfgColorForm) return;

  // Load persisted colours (fall back to defaults)
  try {
    chrome.storage.local.get('answerBlockColors').then((res) => {
      const saved = (res && res.answerBlockColors) || {};
      ['form', 'image', 'current'].forEach((k) => {
        const v = saved[k] || DEFAULT_BLOCK_COLORS[k];
        applyBlockColor(k, v);
      });
    }).catch(() => {
      ['form', 'image', 'current'].forEach((k) => applyBlockColor(k, DEFAULT_BLOCK_COLORS[k]));
    });
  } catch (_) {
    ['form', 'image', 'current'].forEach((k) => applyBlockColor(k, DEFAULT_BLOCK_COLORS[k]));
  }

  // Live preview on change + persist
  const wire = (picker, target) => {
    if (!picker) return;
    picker.addEventListener('input', () => applyBlockColor(target, picker.value));
    picker.addEventListener('change', () => { applyBlockColor(target, picker.value); persistBlockColors(); });
  };
  wire(els.cfgColorForm, 'form');
  wire(els.cfgColorImage, 'image');
  wire(els.cfgColorCurrent, 'current');

  // Reset buttons: per-row revert to default
  document.querySelectorAll('.color-reset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.target;
      if (!t || !DEFAULT_BLOCK_COLORS[t]) return;
      applyBlockColor(t, DEFAULT_BLOCK_COLORS[t]);
      persistBlockColors();
    });
  });
}


// ═════════════════════════════════════════════════════════════════════
// 10b. Sign-in gate — LMS licence check
// ═════════════════════════════════════════════════════════════════════
//
// Replaces the "Who's using Smart Fill?" roster picker. That gate asked who
// you were and believed the answer; this one asks the AdminPortal LMS, which
// checks a password, an assigned licence, the customer's status and the
// expiry date, and binds this installation to a seat.
//
// The difference that matters is what happens when it fails. The old gate was
// best-effort and deliberately un-blocking: usage tracking must never stop
// someone doing their job. This one blocks, because the backend now rejects
// unauthenticated calls - letting the panel through would only produce 401s
// with no explanation.
//
// The session carries user_id and license_id, which is what common/lmsUsage.js
// needs to meter image processing against the right licence.

const gateEls = {
  gate: document.getElementById('profile-gate'),
  form: document.getElementById('profile-login'),
  username: document.getElementById('login-username'),
  password: document.getElementById('login-password'),
  submit: document.getElementById('login-submit'),
  sub: document.getElementById('profile-gate-sub'),
  error: document.getElementById('profile-gate-error'),
  errorText: document.getElementById('profile-gate-error-text'),
  retry: document.getElementById('profile-gate-retry'),
  cancel: document.getElementById('profile-gate-cancel'),
  chip: document.getElementById('profile-chip'),
  chipName: document.getElementById('profile-chip-name'),
};

// True when the gate was opened by the footer chip (an explicit "switch user")
// rather than by a missing session. Only then is Cancel offered - otherwise
// there is no signed-in state to fall back to.
let gateIsSwitching = false;

function renderProfileChip(session) {
  if (!gateEls.chip || !gateEls.chipName) return;
  if (!session) {
    gateEls.chip.hidden = true;
    return;
  }
  gateEls.chipName.textContent = session.username;
  gateEls.chip.title = session.plan_name
    ? `Signed in as ${session.username} (${session.plan_name}) — click to sign out`
    : `Signed in as ${session.username} — click to sign out`;
  gateEls.chip.hidden = false;
}

function closeProfileGate() {
  if (gateEls.gate) gateEls.gate.hidden = true;
  gateIsSwitching = false;
  if (gateEls.password) gateEls.password.value = '';
}

function showGateError(message) {
  if (!gateEls.error || !gateEls.errorText) return;
  gateEls.errorText.textContent = message;
  gateEls.error.hidden = false;
}

/**
 * Copy for the gate's sub-heading. The involuntary cases need their own
 * wording: the default line reads as a first-run prompt, so someone who was
 * signed in a minute ago would reasonably wonder what happened.
 */
const GATE_SUBTITLES = {
  switching: 'Sign in as a different user.',
  first_run: "Use your NSR licence account. You'll stay signed in on this browser.",
  expired: 'Your session has expired. Sign in again to continue.',
  revoked: 'Your licence is no longer active on this device. Sign in again, or contact your administrator if this is unexpected.',
  signed_out: 'You have been signed out.',
};

/**
 * Open the gate.
 * @param {boolean} switching  opened from the footer chip (Cancel allowed)
 * @param {string=} reason     'expired' | 'revoked' | 'signed_out'
 */
function openProfileGate(switching = false, reason = '') {
  if (!gateEls.gate) return;

  gateIsSwitching = switching;
  gateEls.gate.hidden = false;
  if (gateEls.cancel) gateEls.cancel.hidden = !switching;
  if (gateEls.sub) {
    gateEls.sub.textContent =
      GATE_SUBTITLES[reason] ||
      (switching ? GATE_SUBTITLES.switching : GATE_SUBTITLES.first_run);
  }
  if (gateEls.error) gateEls.error.hidden = true;
  if (gateEls.submit) gateEls.submit.disabled = false;

  // Focus whichever field is empty so a re-auth after expiry doesn't make the
  // user retype a username that is already correct.
  try {
    if (gateEls.username && !gateEls.username.value) gateEls.username.focus();
    else if (gateEls.password) gateEls.password.focus();
  } catch (_) { /* ignore */ }
}

/**
 * Attempt a sign-in and, on success, stand up the session-derived identity
 * the usage pipeline needs.
 */
async function submitLogin(username, password) {
  if (gateEls.submit) {
    gateEls.submit.disabled = true;
    gateEls.submit.textContent = 'Signing in…';
  }
  if (gateEls.error) gateEls.error.hidden = true;

  try {
    const result = await window.NSR_AUTH.signIn(username, password);

    if (!result.ok) {
      // `reason` is the LMS's own message - it distinguishes a wrong password
      // from a suspended licence from "no licence available for this device",
      // and those need different actions. Never replace it with a generic one.
      showGateError(result.reason);
      return;
    }

    renderProfileChip(result.session);
    closeProfileGate();

    if (result.session.mustChangePassword) {
      // The LMS issued this account a temporary password. Nothing here is
      // blocked by that - the token is valid - but it expires on the LMS's own
      // schedule, and someone who is never told will be locked out with no idea
      // why. Say it once, prominently, rather than burying it.
      showToast('Your password is temporary — change it in the admin portal', 8000);
    } else {
      showToast(`Signed in as ${result.session.username}`);
    }
  } catch (err) {
    console.error('[SmartFill] Sign-in failed:', err);
    showGateError('Something went wrong signing in. Try again.');
  } finally {
    if (gateEls.submit) {
      gateEls.submit.disabled = false;
      gateEls.submit.textContent = 'Sign in';
    }
  }
}

async function initProfileGate() {
  // auth.js missing (load order changed, file removed) - fail closed. The
  // backend will reject every call anyway, so a broken gate must not read as
  // an open one.
  if (!window.NSR_AUTH || !gateEls.gate) {
    console.error('[SmartFill] Auth layer unavailable - sign-in gate cannot open');
    return;
  }

  try {
    await window.NSR_AUTH.getInstallationId();   // ensure the seat id exists

    const session = await window.NSR_AUTH.getSession();
    renderProfileChip(session);

    if (!session) {
      // Distinguish a genuine first run from a session the worker ended while
      // the panel was closed - the copy for those is not the same.
      const reason = await window.NSR_AUTH.getEndedReason();
      openProfileGate(false, reason);
    } else {
      // Re-confirm the licence on every open (guide §4). consume IS the check -
      // there is no separate "am I still licensed" call - and it is idempotent
      // for a device that already holds one, so this costs a request and
      // consumes nothing. Without it a revoked licence stays invisible until
      // the access token happens to expire, up to 30 minutes later.
      //
      // Deliberately not awaited: the panel should render immediately, and the
      // gate reopens by itself if the answer comes back negative.
      window.NSR_AUTH.ensureLicense()
        .then((lic) => {
          if (lic.granted) return;
          renderProfileChip(null);
          openProfileGate(false, 'revoked');
          // The LMS's reason is more specific than the gate's stock copy
          // ("licence expired", "no licence available"), so show it too.
          if (lic.reason) showGateError(lic.reason);
        })
        .catch(() => { /* offline: leave the session alone rather than sign out */ });
    }

    gateEls.form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const u = (gateEls.username?.value || '').trim();
      const p = gateEls.password?.value || '';
      if (!u || !p) {
        showGateError('Enter both your username and password.');
        return;
      }
      submitLogin(u, p);
    });

    // The chip is now a sign-out affordance. Signing out releases nothing
    // server-side on purpose: the device keeps its licence binding, so signing
    // back in on the same machine does not consume a second seat.
    gateEls.chip?.addEventListener('click', async () => {
      await window.NSR_AUTH.signOut();
      renderProfileChip(null);
      openProfileGate(true, 'signed_out');
    });

    gateEls.retry?.addEventListener('click', () => {
      if (gateEls.error) gateEls.error.hidden = true;
      openProfileGate(gateIsSwitching);
    });

    gateEls.cancel?.addEventListener('click', closeProfileGate);

    // Esc closes, but only when switching - with no session there is nothing
    // to fall back to, so the gate stays put.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && gateIsSwitching) closeProfileGate();
    });

    // The 401 that ends a session is detected in the service worker, which
    // cannot reach this document. Watching the storage key is the join: the
    // worker clears `lmsSession`, and an already-open panel reacts now rather
    // than on next open. Removal only - a refresh writes a new value.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.lmsSession) return;
      if (changes.lmsSession.newValue) return;      // refreshed, not ended
      if (!changes.lmsSession.oldValue) return;     // already absent
      renderProfileChip(null);
      window.NSR_AUTH.getEndedReason()
        .then((reason) => openProfileGate(false, reason || 'expired'))
        .catch(() => { });
    });
  } catch (err) {
    console.error('[SmartFill] Sign-in gate init failed:', err);
    // Fail closed: leave the gate open rather than silently admitting someone.
    openProfileGate(false);
  }
}

// ═════════════════════════════════════════════════════════════════════
// 10c. Feedback delivery on close
// ═════════════════════════════════════════════════════════════════════
//
// The draft is already in chrome.storage.local, so even if this message
// never arrives the worker's alarm delivers the review within a minute.
// This just makes the common case immediate.

function initFeedbackOnClose() {
  window.addEventListener('pagehide', () => {
    try {
      if (hasUnsentReview()) {
        clearTimeout(draftSaveTimer);
        saveFeedbackDraftNow();
        flushFeedbackDraft('auto_close');
      }
    } catch (_) { /* ignore */ }
  });
}

// ═════════════════════════════════════════════════════════════════════
// 11. Bootstrap
// ═════════════════════════════════════════════════════════════════════

initThemeToggle();
initProfileGate();
initFeedbackOnClose();
setRingProgress(0);
setConnection('idle', 'Idle');
setStatusBadge('IDLE', 'idle');
renderSupportedList();
initColorPickers();
requestDetection();
