/**
 * page/photos-agent.js - MAIN-world Order/Edit Photos support.
 *
 * Port of NSR_LMS `content/images.js`. Same public surface, different page
 * contract, and it must run in the MAIN world because two of the things it
 * needs are page-context objects invisible to an isolated content script:
 *
 *   $(li).tmplItem().data                  the photo record behind each tile
 *   InspectionForms.photoRules             label-collection vs free-text mode
 *
 * Registers its actions into the dispatch table owned by dynforms-agent.js.
 *
 * ── Page contract (verified live, survey #22081) ───────────────────────
 *
 *   #orderDialog                                  jQuery UI dialog
 *     └ ul.connectedSortable.ui-sortable
 *         └ li.order-photo-item  ×N
 *             ├ div.image-container > img         src carries photoID
 *             ├ input#photoLabelId    (hidden)
 *             ├ input#photoCategoryId (hidden)
 *             ├ input#photoGroupId    (hidden)
 *             ├ input.img-description (text)      free-text label
 *             └ select.img-label-select           only when UseLabelCollections
 *
 * ── Ordering ───────────────────────────────────────────────────────────
 *
 * The site's save handler iterates `$("li.order-photo-item").each()` and pushes
 * one record per tile; **array position is the order** - there is no index
 * field. The sortable's own start/stop callbacks only manage multi-select
 * highlighting, they record nothing.
 *
 * So a sort is a plain DOM move. No drag simulation, no synthetic mouse
 * events, no jQuery UI internals. Verified: reordering by appendChild keeps
 * each tile's tmplItem() binding intact and survives sortable('refresh').
 *
 * This module never saves. It stages changes in the open dialog exactly as a
 * human would, and the inspector clicks "Save Changes to Photos" themselves.
 */

(() => {
  if (window.__NSR_BOOST_PHOTOS__) return;
  window.__NSR_BOOST_PHOTOS__ = true;

  const SEL = {
    dialog:      '#orderDialog',
    sortable:    '#orderDialog ul.connectedSortable',
    li:          'li.order-photo-item',
    img:         '.image-container img',
    descInput:   'input.img-description',
    labelSelect: 'select.img-label-select',
    catSelect:   'select.img-category-select',
    saveButton:  '#savePhotoChangesButton',
  };

  // Snapshot of the panel as first seen, so "Original" can always be restored.
  // Keyed per inspection: the dialog is built once and reused, but the photo
  // set changes when the user moves to another inspection.
  window.__NSR_BOOST_PHOTO_STATE__ = window.__NSR_BOOST_PHOTO_STATE__ || {
    inspectionID: null,
    originalOrder: [],   // photoId[], in original DOM order
    originalLabels: {},  // photoId → original label string
  };
  const STATE = window.__NSR_BOOST_PHOTO_STATE__;

  const $ = () => window.jQuery;

  // ── Panel state ───────────────────────────────────────────────────

  /**
   * Whether the Order/Edit Photos dialog is *open*.
   *
   * Presence is not enough: closing the dialog leaves #orderDialog in the DOM
   * with every <li> and the save button still attached, so a presence check
   * reports "open" forever after the first open. Visibility is the real
   * signal (offsetParent is null for a hidden dialog).
   */
  function isPanelOpen() {
    const el = document.querySelector(SEL.dialog);
    if (!el) return false;
    if (el.offsetParent === null) return false;
    const jq = $();
    if (jq) {
      try { return jq(el).dialog('isOpen') === true; } catch (_) { /* not a dialog yet */ }
    }
    return true;
  }

  /**
   * How this tenant labels photos.
   *
   *   UseLabelCollections false → free text in input.img-description
   *   UseLabelCollections true  → pick from select.img-label-select (select2),
   *                               and the saved value is a PhotoLabelID
   *
   * The analysis survey runs in free-text mode, but the flag is per-tenant so
   * both paths have to exist.
   */
  function labelMode() {
    const rules = window.InspectionForms && window.InspectionForms.photoRules;
    const useCollections = !!(rules && rules.UseLabelCollections);
    return {
      useCollections,
      allowTextbox: !rules || rules.AllowTextboxDescription !== false,
      labels: rules && Array.isArray(rules.PhotoLabels)
        ? rules.PhotoLabels
            .filter((l) => l && l.Value !== '-1' && l.Value !== '')
            .map((l) => ({ id: String(l.Value), text: String(l.Text) }))
        : [],
    };
  }

  /**
   * The dynforms-agent context, or {} when no form is loaded. The photo panel
   * can be opened from pages where the engine has nothing (e.g. Attach Files),
   * so this must never throw.
   */
  function safeContext() {
    try {
      return window.__NSR_BOOST_ACTIONS__.context() || {};
    } catch (_) {
      return {};
    }
  }

  function panelState() {
    const open = isPanelOpen();
    return {
      open,
      count: open ? items().length : 0,
      ...labelMode(),
      inspectionID: window.InspectionID || null,
    };
  }

  // ── Per-tile helpers ──────────────────────────────────────────────

  function sortableEl() {
    return document.querySelector(SEL.sortable);
  }

  function items() {
    const ul = sortableEl();
    return ul ? Array.from(ul.querySelectorAll(SEL.li)) : [];
  }

  /**
   * Photo id for a tile. `tmplItem().data.InspectionPhotoID` is authoritative;
   * the img src query string is the fallback for when the template binding is
   * missing (it carries the same GUID).
   */
  function photoIdOf(li) {
    const jq = $();
    if (jq) {
      try {
        const data = jq(li).tmplItem().data;
        if (data && data.InspectionPhotoID) return String(data.InspectionPhotoID);
      } catch (_) { /* fall through */ }
    }
    const img = li.querySelector(SEL.img);
    const src = img ? img.getAttribute('src') || '' : '';
    const m = src.match(/[?&]photoID=([^&]+)/i);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function recordOf(li) {
    const jq = $();
    if (!jq) return null;
    try { return jq(li).tmplItem().data || null; } catch (_) { return null; }
  }

  function getLabel(li) {
    const mode = labelMode();
    if (mode.useCollections) {
      const sel = li.querySelector(SEL.labelSelect);
      if (sel) {
        const opt = sel.options[sel.selectedIndex];
        return opt && opt.value !== '-1' ? (opt.textContent || '').trim() : '';
      }
    }
    const input = li.querySelector(SEL.descInput);
    return input ? (input.value || '').trim() : '';
  }

  /**
   * Write a label onto one tile.
   *
   * Free-text mode is a plain <input> (no framework in between), so setting
   * .value plus input/change is enough. Collection mode has to resolve the
   * text to a PhotoLabelID and drive select2, which needs its own change
   * notification or the widget keeps showing the old choice.
   */
  function setLabelOnLi(li, label) {
    const mode = labelMode();
    const text = label == null ? '' : String(label);

    if (mode.useCollections) {
      const sel = li.querySelector(SEL.labelSelect);
      if (!sel) return false;

      const wanted = text.trim().toLowerCase();
      const match = Array.from(sel.options).find(
        (o) => (o.textContent || '').trim().toLowerCase() === wanted
      );
      if (!match) return false; // AI produced a label outside the collection

      sel.value = match.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      const jq = $();
      if (jq && jq(sel).data('select2')) {
        try { jq(sel).trigger('change.select2'); } catch (_) { /* non-fatal */ }
      }
      return true;
    }

    const input = li.querySelector(SEL.descInput);
    if (!input) return false;
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function findLi(photoId) {
    if (!photoId) return null;
    return items().find((li) => photoIdOf(li) === photoId) || null;
  }

  /**
   * Capture the original order and labels, once per inspection, before any
   * mutation. Re-snapshots when the inspection changes so "Original" never
   * restores another survey's state.
   */
  function ensureSnapshot() {
    const list = items();
    if (!list.length) return;

    const currentInspection = window.InspectionID || null;
    if (STATE.originalOrder.length && STATE.inspectionID === currentInspection) return;

    STATE.inspectionID = currentInspection;
    STATE.originalOrder = list.map(photoIdOf);
    STATE.originalLabels = {};
    list.forEach((li) => { STATE.originalLabels[photoIdOf(li)] = getLabel(li); });
  }

  // ── Extraction ────────────────────────────────────────────────────

  function extractTiles() {
    const origin = window.location.origin;
    const absolutise = (p) => (p && p.startsWith('http') ? p : origin + p);

    // Tile thumbnails carry size=150. Dropping the parameter entirely gives
    // the original image, which is what the full-res viewer wants.
    const stripSize = (url) => url
      .replace(/([?&])size=\d+&?/i, '$1')
      .replace(/[?&]$/, '');

    return items().map((li) => {
      const img = li.querySelector(SEL.img);
      const thumb = img ? img.getAttribute('src') || '' : '';
      const rec = recordOf(li) || {};

      return {
        photoId: photoIdOf(li),
        label: getLabel(li),          // raw value; the "(No label)" placeholder is a UI concern
        thumbnailUrl: absolutise(thumb),
        fullResUrl: absolutise(stripSize(thumb)),
        isHazard: !!rec.IsHazard,
        showOnReport: rec.ShowOnReport !== false,
        editable: rec.Editable !== false,
        photoLabelID: rec.PhotoLabelID != null ? String(rec.PhotoLabelID) : '',
        photoCategoryID: rec.PhotoCategoryId != null ? String(rec.PhotoCategoryId) : '',
        photoGroupID: rec.PhotoGroupId != null ? String(rec.PhotoGroupId) : '',
      };
    });
  }

  /**
   * Read the open panel. Mirrors NSR_LMS extract(), including the
   * NOT_ORDER_PHOTOS_PAGE error code the side panel already branches on -
   * here it means "the Order/Edit Photos dialog isn't open".
   */
  function extractPanel() {
    // Survey number and type come from the engine, not the page title - form
    // pages are titled "BOOSTUSA : <form name>" with no number in them.
    const ctx = window.__NSR_BOOST_ACTIONS__ && window.__NSR_BOOST_ACTIONS__.context
      ? safeContext()
      : {};

    const meta = {
      inspectionID: ctx.inspectionID || window.InspectionID || '',
      surveyNumber: ctx.surveyNumber || '',
      surveyType: ctx.surveyType || '',
      pageTitle: document.title || '',
      ...labelMode(),
    };

    if (!isPanelOpen()) {
      return {
        error: 'NOT_ORDER_PHOTOS_PAGE',
        reason: 'Open the Order/Edit Photos panel (the ORDER button above the photo rail).',
        meta,
      };
    }
    if (!sortableEl() || items().length === 0) {
      return { error: 'NOT_ORDER_PHOTOS_PAGE', reason: 'No photos in the panel', meta };
    }

    ensureSnapshot();
    return { meta, images: extractTiles() };
  }

  // ── Mutations ─────────────────────────────────────────────────────

  function guard() {
    if (!isPanelOpen()) return { ok: false, error: 'The Order/Edit Photos panel is not open.' };
    if (!sortableEl()) return { ok: false, error: 'Photo list not found in the panel.' };
    if (items().length === 0) return { ok: false, error: 'No photos in the panel.' };
    return null;
  }

  /**
   * AI sort: apply the order the API returned, and write each photo's chosen
   * label.
   *
   * `order` is a photoId[] - the API decides the sequence directly (there is
   * no label taxonomy to sort against on BoostUSA, since labels are free
   * text). Photos the API didn't mention keep their relative order and are
   * appended after the ones it did.
   *
   * `labelMap` is { photoId: label }. The side panel owns the per-photo
   * AI/Original choice and passes the resolved map, so a photo the inspector
   * flipped back to Original is simply absent or carries its original text.
   */
  function applyApiResults(order, labelMap) {
    const bad = guard();
    if (bad) return bad;

    ensureSnapshot();
    const list = items();

    if (labelMap) {
      list.forEach((li) => {
        const pid = photoIdOf(li);
        if (Object.prototype.hasOwnProperty.call(labelMap, pid)) setLabelOnLi(li, labelMap[pid]);
      });
    }

    const wanted = Array.isArray(order) ? order : [];
    const ordered = [];
    wanted.forEach((pid) => {
      const li = list.find((x) => photoIdOf(x) === pid);
      if (li && !ordered.includes(li)) ordered.push(li);
    });
    list.forEach((li) => { if (!ordered.includes(li)) ordered.push(li); });

    reorder(ordered);
    return { ok: true, images: extractTiles() };
  }

  /**
   * Restore the original order. Labels follow `labelMap` when given (so
   * per-photo choices survive an order reset); with no map, every label goes
   * back to its snapshot value - the full "Original" pill.
   */
  function restoreOriginal(labelMap) {
    const bad = guard();
    if (bad) return bad;

    const list = items();

    list.forEach((li) => {
      const pid = photoIdOf(li);
      if (labelMap && Object.prototype.hasOwnProperty.call(labelMap, pid)) {
        setLabelOnLi(li, labelMap[pid]);
      } else if (!labelMap) {
        const original = STATE.originalLabels[pid];
        if (original != null) setLabelOnLi(li, original);
      }
    });

    if (STATE.originalOrder.length) {
      const rank = (li) => {
        const i = STATE.originalOrder.indexOf(photoIdOf(li));
        return i === -1 ? Number.MAX_SAFE_INTEGER : i;
      };
      reorder(list.slice().sort((a, b) => rank(a) - rank(b)));
    }

    return { ok: true, images: extractTiles() };
  }

  /**
   * Move tiles into the given order in one reflow, then tell jQuery UI
   * Sortable to re-measure so a subsequent manual drag behaves.
   */
  function reorder(ordered) {
    const ul = sortableEl();
    const frag = document.createDocumentFragment();
    ordered.forEach((li) => frag.appendChild(li));
    ul.appendChild(frag);

    const jq = $();
    if (jq) {
      try { jq(ul).sortable('refresh'); } catch (_) { /* not sortable - fine */ }
    }
  }

  function setPhotoLabel(photoId, label) {
    const bad = guard();
    if (bad) return bad;
    ensureSnapshot();
    const li = findLi(photoId);
    if (!li) return { ok: false, error: 'Photo not found in the panel.' };
    return setLabelOnLi(li, label)
      ? { ok: true }
      : { ok: false, error: 'Could not write the label (unknown value for this label list?).' };
  }

  function applyLabelMap(labelMap) {
    const bad = guard();
    if (bad) return bad;
    ensureSnapshot();
    items().forEach((li) => {
      const pid = photoIdOf(li);
      if (labelMap && Object.prototype.hasOwnProperty.call(labelMap, pid)) {
        setLabelOnLi(li, labelMap[pid]);
      }
    });
    return { ok: true, images: extractTiles() };
  }

  function focusPhoto(photoId) {
    const li = findLi(photoId);
    if (!li) return { ok: false, error: 'Photo not found in the panel.' };

    ensureHighlightStyle();
    try {
      li.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    } catch (_) {
      li.scrollIntoView();
    }

    const CLASS = '__nsr_boost_photo_flash__';
    setTimeout(() => {
      li.classList.remove(CLASS);
      void li.offsetWidth; // force reflow so a repeat focus re-runs the animation
      li.classList.add(CLASS);
      setTimeout(() => li.classList.remove(CLASS), 2100);
    }, 250);

    return { ok: true };
  }

  function ensureHighlightStyle() {
    const ID = '__nsr_boost_photo_flash_style__';
    if (document.getElementById(ID)) return;
    const style = document.createElement('style');
    style.id = ID;
    style.textContent = `
      @keyframes nsr-boost-photo-flash {
        0%   { box-shadow: 0 0 0 0 rgba(250,204,21,0);    background-color: rgba(254,240,138,0); }
        12%  { box-shadow: 0 0 0 4px rgba(250,204,21,.6); background-color: rgba(254,240,138,.5); }
        70%  { box-shadow: 0 0 0 4px rgba(250,204,21,.35);background-color: rgba(254,240,138,.3); }
        100% { box-shadow: 0 0 0 0 rgba(250,204,21,0);    background-color: rgba(254,240,138,0); }
      }
      .__nsr_boost_photo_flash__ {
        animation: nsr-boost-photo-flash 2000ms ease-out forwards;
        border-radius: 8px;
      }
    `;
    document.head.appendChild(style);
  }

  // ── Register with the shared dispatch ──────────────────────────────

  const ACTIONS = window.__NSR_BOOST_ACTIONS__;
  if (ACTIONS) {
    ACTIONS.photoPanelState  = () => panelState();
    ACTIONS.extractPanel     = () => extractPanel();
    ACTIONS.applyApiResults  = (p) => applyApiResults(p && p.order, p && p.labelMap);
    ACTIONS.restoreOriginal  = (p) => restoreOriginal(p && p.labelMap);
    ACTIONS.setPhotoLabel    = (p) => setPhotoLabel(p && p.photoId, p && p.label);
    ACTIONS.applyLabelMap    = (p) => applyLabelMap(p && p.labelMap);
    ACTIONS.focusPhoto       = (p) => focusPhoto(p && p.photoId);
  } else {
    console.warn('[NSR-Boost] photos-agent loaded before dynforms-agent; actions not registered');
  }
})();
