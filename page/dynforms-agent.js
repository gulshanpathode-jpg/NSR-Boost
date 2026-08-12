/**
 * page/dynforms-agent.js - MAIN-world agent for the BoostUSA DynForms engine.
 *
 * This file runs in the *page's own* JavaScript context (manifest
 * `"world": "MAIN"`), which is the only way to reach:
 *
 *   window.DynForms                      the form engine + schema
 *   window.LC360Forms                    form instance, mode flags, save
 *   jQuery.data(el, 'dynControl')        the live control instance per field
 *
 * A normal (isolated-world) content script sees none of those, so everything
 * that touches the engine lives here. `content/bridge.js` is the isolated-world
 * counterpart; the two talk over window.postMessage.
 *
 * Protocol
 *   request   { source:'NSR_BOOST_REQ', id, action, payload }
 *   response  { source:'NSR_BOOST_RES', id, ok, data }  |  { ..., ok:false, error }
 *
 * See docs/PLATFORM-ANALYSIS.md for how the engine was mapped.
 *
 * Design rule: this agent never saves and never mutates on its own. Writes
 * happen only in response to an explicit `setValues` / `save` request.
 */

(() => {
  if (window.__NSR_BOOST_AGENT__) return;
  window.__NSR_BOOST_AGENT__ = true;

  const REQ = 'NSR_BOOST_REQ';
  const RES = 'NSR_BOOST_RES';

  // ── Engine handles ────────────────────────────────────────────────

  const $ = () => window.jQuery;

  /** Root MainForm control. Null when no DynForms form is on the page. */
  function rootForm() {
    const jq = $();
    if (!jq) return null;
    const el = document.querySelector('.dyn-mainform');
    if (!el) return null;
    return jq(el).data('dynControl') || null;
  }

  /** Live control instance for a control GUID. */
  function controlById(controlID) {
    const jq = $();
    if (!jq || !controlID) return null;
    const el = document.getElementById(controlID);
    if (!el) return null;
    return jq(el).data('dynControl') || null;
  }

  function formInstance() {
    try {
      return window.LC360Forms && window.LC360Forms.getLoadedFormInstance
        ? window.LC360Forms.getLoadedFormInstance()
        : null;
    } catch (_) {
      return null;
    }
  }

  // ── Mode detection ────────────────────────────────────────────────

  /**
   * Whether the form is actually editable.
   *
   * In review / print view every control renders via `renderPrintView()` and
   * no input elements exist at all - `setValue()` would update the model but
   * there is nothing on screen and nothing to save. Callers must check this
   * before attempting a write. See PLATFORM-ANALYSIS.md §5.
   */
  function readMode() {
    const F = window.LC360Forms;
    const inst = formInstance();
    const get = (name) => {
      try { return F && F[name] ? F[name]() : null; } catch (_) { return null; }
    };

    const isReview = get('getIsReview');
    const printView = inst ? !!inst.printView : null;
    const inputCount = document.querySelectorAll('.dyn-input-container input, .dyn-input-container textarea, .dyn-input-container select').length;

    return {
      isReview,
      isFieldRep: get('getIsFieldRep'),
      isSelfSurvey: get('getIsSelfSurvey'),
      isMobile: get('getIsMobile'),
      isOffline: get('getIsOffline'),
      isAudit: inst ? !!inst.isAudit : null,
      canAddRecs: inst ? !!inst.canAddRecs : null,
      printView,
      isUserInspector: window.isUserInspector === true,
      inspectionStatusID: window.inspectionStatusID != null ? String(window.inspectionStatusID) : null,
      renderedInputCount: inputCount,
      // Belt and braces: trust the rendered inputs over the flags. A form with
      // controls but no inputs is read-only no matter what the flags claim.
      editable: !isReview && printView !== true && inputCount > 0,
    };
  }

  // ── Schema ────────────────────────────────────────────────────────

  /**
   * Flatten DynForms.FormVersions into controlID → schema control.
   *
   * FormVersions is keyed by main-form version id, then by section id:
   *   FormVersions[mainID][sectionID] = { name, formVersionID, controls[], version }
   */
  function schemaByControlId() {
    const map = new Map();
    const FV = window.DynForms && window.DynForms.FormVersions;
    if (!FV) return map;

    for (const mainID of Object.keys(FV)) {
      const sections = FV[mainID];
      if (!sections || typeof sections !== 'object') continue;
      for (const sectionID of Object.keys(sections)) {
        const section = sections[sectionID];
        const controls = section && section.controls;
        if (!Array.isArray(controls)) continue;
        for (const c of controls) {
          const id = c && c.settings && c.settings.controlID;
          if (id) map.set(id, c);
        }
      }
    }
    return map;
  }

  /** Label text for a control, preferring the live instance. */
  function labelOf(ctrl, schemaCtrl) {
    const fromInstance = ctrl && typeof ctrl.questionText === 'string' ? ctrl.questionText : '';
    if (fromInstance.trim()) return clean(fromInstance);

    const langs = schemaCtrl && schemaCtrl.settings && schemaCtrl.settings.languages;
    const text = Array.isArray(langs) && langs[0] ? langs[0].text : '';
    return clean(text || '');
  }

  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\s*:\s*$/, '')
      .trim();
  }

  /**
   * Map a DynForms control type to the inputType vocabulary the backend
   * already speaks (unchanged from the NSR_LMS contract).
   *
   * Note WKFC: Core Revised uses no DropDownList - `select` is mapped for
   * completeness but is not exercised by this form.
   */
  function inputTypeOf(schemaType, container, schemaCtrl) {
    switch (schemaType) {
      case 'RadioButtonList': return 'radio';
      case 'CheckBoxList':    return 'checkbox';
      case 'DropDownList':    return 'select';
      case 'TableMultiselect':return 'checkbox';
      case 'DatePicker':      return 'text';
      case 'RichText':        return 'textarea';
      case 'TextBox': {
        // TextBox renders as a <textarea> when the definition asks for
        // multiple rows; the backend prompt distinguishes the two.
        const rows = schemaCtrl && schemaCtrl.settings && schemaCtrl.settings.options
          ? schemaCtrl.settings.options.rows
          : null;
        return rows && Number(rows) > 1 ? 'textarea' : 'text';
      }
      default: break;
    }
    // Fallback: the container carries a type-suffixed class.
    const cls = container ? String(container.className || '') : '';
    if (cls.includes('dyn-input-container-radiobuttonlist')) return 'radio';
    if (cls.includes('dyn-input-container-checkboxlist')) return 'checkbox';
    return 'text';
  }

  /**
   * Choices for radio / checkbox as `[{ label, selected }]`.
   *
   * `getCurrentControlItems()` is the authoritative source: verified live, it
   * returns `[{ value: '<label text>', checked: <bool> }]` already resolved
   * for the active language and with any rule-filtered items removed. It
   * carries the selection state too, so there is no need to reconcile against
   * `getValue()` (which returns null for an unanswered choice control).
   *
   * The schema's `settings.options.items[languageID]` is the fallback for the
   * cases where the live list is unavailable - it gives labels but no
   * selection, so selection is then reconciled from `getValue()`.
   */
  function optionList(ctrl, schemaCtrl, value) {
    if (ctrl && typeof ctrl.getCurrentControlItems === 'function') {
      try {
        const items = ctrl.getCurrentControlItems();
        if (Array.isArray(items) && items.length) {
          return items.map((i) => ({
            label: clean(i && typeof i === 'object' ? i.value : i),
            selected: !!(i && i.checked),
          }));
        }
      } catch (_) { /* fall through to schema */ }
    }

    const opts = schemaCtrl && schemaCtrl.settings && schemaCtrl.settings.options;
    const items = opts && opts.items;
    if (!items || typeof items !== 'object') return [];

    const langID = activeLanguageId();
    const list = items[langID] || items[1] || items[Object.keys(items)[0]];
    if (!Array.isArray(list)) return [];

    const selected = toSelectedSet(value);
    return list.map((raw) => {
      const label = clean(raw);
      return { label, selected: selected.has(label) };
    });
  }

  function activeLanguageId() {
    const inst = formInstance();
    const fi = inst && inst.engine && inst.engine.formInfo;
    const id = fi && fi.languageID;
    return id != null ? id : 1;
  }

  function safeGetValue(ctrl) {
    if (!ctrl || typeof ctrl.getValue !== 'function') return null;
    try {
      const v = ctrl.getValue();
      return v === undefined ? null : v;
    } catch (_) {
      return null;
    }
  }

  // ── Extraction ────────────────────────────────────────────────────

  /**
   * Walk the rendered form in document order, grouping fields under the
   * section / sub-section headings they appear beneath.
   *
   * Document order matters: the schema's section records have empty `name`
   * fields, so the human-readable headings only exist in the DOM
   * (.dyn-mainSection-title / .dyn-subSection-title).
   */
  function extract() {
    const root = document.querySelector('.dyn-mainform');
    if (!root) return { items: [], sections: [], stats: { sections: 0, questions: 0 } };

    const schema = schemaByControlId();
    const items = [];

    const SELECTOR = '.dyn-mainSection-title, .dyn-subSection-title, .dyn-input-container';
    const nodes = Array.from(root.querySelectorAll(SELECTOR));

    for (const node of nodes) {
      const cls = String(node.className || '');

      if (cls.includes('dyn-mainSection-title')) {
        items.push({ type: 'header', text: clean(node.textContent) });
        continue;
      }
      if (cls.includes('dyn-subSection-title')) {
        items.push({ type: 'subheader', text: clean(node.textContent), id: node.id || '', level: 1 });
        continue;
      }

      const q = extractControl(node, schema);
      if (q) items.push(q);
    }

    return groupIntoSections(items);
  }

  function extractControl(container, schema) {
    const controlID = container.id;
    if (!controlID) return null;

    const ctrl = controlById(controlID);
    const schemaCtrl = schema.get(controlID) || null;

    // StaticHtml blocks are prose, not questions.
    const schemaType = schemaCtrl ? schemaCtrl.type : null;
    if (schemaType === 'StaticHtml' || schemaType === 'FormControl') return null;

    // Hidden by a visibility rule or by a collapsed parent → the engine has
    // already decided this field does not apply. Sending it to the AI would
    // invite answers to questions the form is not asking.
    if (ctrl && (ctrl.hiddenByRules === true || ctrl.hiddenByParent === true || ctrl.visible === false)) {
      return null;
    }

    const questionText = labelOf(ctrl, schemaCtrl);
    if (!questionText) return null;

    const inputType = inputTypeOf(schemaType, container, schemaCtrl);
    const value = safeGetValue(ctrl);

    const item = {
      type: 'question',
      questionId: controlID,
      questionText,
      inputType,
      answer: null,
      // The engine is the write target, so the "element id" the backend echoes
      // back is the control GUID rather than an <input> id.
      inputElementId: controlID,
    };

    if (inputType === 'radio' || inputType === 'checkbox' || inputType === 'select') {
      const choices = optionList(ctrl, schemaCtrl, value);

      // `id` is the control GUID on every option rather than a per-input
      // element id: the engine is the write target, and choice controls are
      // set as a whole via setValue(), not by clicking individual inputs.
      item.options = choices.map((c) => ({
        id: controlID,
        value: c.label,
        label: c.label,
        selected: c.selected,
      }));

      const picked = choices.filter((c) => c.selected).map((c) => c.label);
      item.answer = inputType === 'checkbox' ? picked : (picked[0] || null);
    } else {
      item.answer = value == null ? '' : String(value);
    }

    return item;
  }

  /** Normalise a control value into a Set of selected option labels. */
  function toSelectedSet(value) {
    if (value == null) return new Set();
    if (Array.isArray(value)) return new Set(value.map(clean).filter(Boolean));
    const s = clean(value);
    return s ? new Set([s]) : new Set();
  }

  /** Same grouping shape the NSR_LMS side panel already renders. */
  function groupIntoSections(items) {
    const sections = [];
    let current = null;
    let subheader = '';

    for (const item of items) {
      if (item.type === 'header') {
        current = { id: `sec_${sections.length}`, text: item.text, questions: [] };
        sections.push(current);
        subheader = '';
        continue;
      }
      if (item.type === 'subheader') {
        subheader = item.text;
        continue;
      }
      if (item.type !== 'question') continue;

      if (!current) {
        current = { id: `sec_${sections.length}`, text: '(General)', questions: [] };
        sections.push(current);
      }
      current.questions.push({
        ...item,
        questionUid: item.questionId,
        subheader,
        sectionId: current.id,
        sectionText: current.text,
      });
    }

    const questions = sections.reduce((n, s) => n + s.questions.length, 0);
    return { items, sections, stats: { sections: sections.length, questions } };
  }

  // ── Context ───────────────────────────────────────────────────────

  function context() {
    const inst = formInstance();
    const fi = inst && inst.engine ? inst.engine.formInfo : null;
    const root = rootForm();
    const inspectionID = (fi && fi.inspectionID) || window.InspectionID || null;

    return {
      hasDynForms: !!window.DynForms,
      hasEngine: !!inst,
      hasRootForm: !!root,
      formTitle: formTitle(),
      inspectionID,
      inspectionFormID: (inst && inst.inspectionFormId) || window.InspectionFormID || null,
      inspectionTypeID: window.InspectionTypeID || null,
      // NOT the survey number - referenceID is a GUID. See surveyNumber().
      referenceID: (fi && fi.referenceID) || null,
      surveyNumber: surveyNumber(fi, inspectionID),
      surveyType: surveyType(fi),
      languageID: fi ? fi.languageID : null,
      cultureCode: fi ? fi.cultureCode : null,
      inspection: inspectionDetails(fi),
      mainSections: Array.from(document.querySelectorAll('.dyn-mainSection-title')).map((e) => clean(e.textContent)),
      controlCount: document.querySelectorAll('.dyn-input-container').length,
      photoCount: fi && Array.isArray(fi.photos) ? fi.photos.length : 0,
      mode: readMode(),
    };
  }

  /**
   * Survey type - the BoostUSA equivalent of NSR's `Utilant.CaseTypeName`.
   *
   * On NSR this had to be scraped out of an inline <script> block because the
   * content script couldn't read the page global. Here it is a plain property
   * on the loaded form instance, available on **every form page** rather than
   * only on General Information:
   *
   *   engine.formInfo.inspectionInfo.inspectionType   e.g. "Rec Management_Test_1"
   *
   * `inspectionTypeCategory` sits alongside it ("Property") but is a coarser
   * grouping and is not what the registry filters on.
   */
  function surveyType(fi) {
    const info = fi && fi.inspectionInfo;
    return info && info.inspectionType ? clean(info.inspectionType) : '';
  }

  /**
   * The human survey number ("22081").
   *
   * It is not `referenceID` (that is a GUID) and not in the page title on form
   * pages. It lives in `relatedInspections[]`, which is matched on
   * inspectionID rather than taken at index 0 - a linked or multi-building
   * inspection can list more than one entry.
   */
  function surveyNumber(fi, inspectionID) {
    const related = fi && Array.isArray(fi.relatedInspections) ? fi.relatedInspections : [];
    if (!related.length) return '';

    const mine = related.find((r) => String(r.inspectionID || '') === String(inspectionID || ''));
    const row = mine || (related.length === 1 ? related[0] : null);
    return row && row.inspectionNumber != null ? String(row.inspectionNumber) : '';
  }

  /** Inspection context the side panel shows (address block, policyholder). */
  function inspectionDetails(fi) {
    const info = (fi && fi.inspectionInfo) || {};
    const addr = info.locationAddress || {};
    return {
      division: info.division || '',
      inspectionType: info.inspectionType || '',
      inspectionTypeCategory: info.inspectionTypeCategory || '',
      policyHolder: [info.policyHolderFirstName, info.policyHolderLastName]
        .map((s) => clean(s || ''))
        .filter(Boolean)
        .join(' '),
      policyHolderCompany: info.policyHolderCompany || '',
      dateReceived: info.dateReceived || '',
      // Structured, so no need to scrape the General Information page and
      // strip its geocode trailer.
      address: {
        street: addr.street1 || '',
        city: addr.city || '',
        region: addr.region1 || '',
        county: addr.region2 || '',
        postalCode: addr.postalCode || '',
        country: addr.country || '',
        formatted: [addr.street1, addr.city, addr.region1, addr.postalCode]
          .filter(Boolean)
          .join(', '),
      },
      latitude: fi && fi.latitudeLongitude ? fi.latitudeLongitude.latitude : null,
      longitude: fi && fi.latitudeLongitude ? fi.latitudeLongitude.longitude : null,
    };
  }

  /** The form name as shown on the active tab in the form header. */
  function formTitle() {
    const tab = document.querySelector('.nav-tabs .active, .formTab.active, [class*=formTabSelected]');
    if (tab) return clean(tab.textContent);
    // Fall back to the document title: "BOOSTUSA : WKFC: Core Revised"
    const t = document.title || '';
    const idx = t.indexOf(' : ');
    return idx >= 0 ? clean(t.slice(idx + 3)) : clean(t);
  }

  /**
   * Photo GUIDs, labels and ready-built URLs, straight off formInfo.
   *
   * The old extension scraped a #sortable DOM grid for this. Here the engine
   * hands over the full list, so the photo panel does not even need to be
   * open. Verified: 50 photos on the analysis survey.
   *
   * URL shape (observed on the live thumbnails):
   *   /Inspection/Images/Image?inspectionID=<guid>&photoID=<guid>&size=150&version=1
   *
   * `size` is the max edge in px; omit it for the original. `getInspectionPhotoUrl`
   * holds the path ("/Inspection/Images/Image") without any query string.
   */
  function photos(opts) {
    const inst = formInstance();
    const fi = inst && inst.engine ? inst.engine.formInfo : null;
    if (!fi || !Array.isArray(fi.photos)) return { photos: [], count: 0 };

    const labels = fi.photoLabels || {};
    const labelValues = fi.photoLabelValues || {};
    const inspectionID = fi.inspectionID || window.InspectionID || '';
    const path = typeof window.getInspectionPhotoUrl === 'string'
      ? window.getInspectionPhotoUrl
      : '/Inspection/Images/Image';
    const size = opts && opts.size ? Number(opts.size) : null;

    const url = (photoID, px) => {
      const q = [`inspectionID=${encodeURIComponent(inspectionID)}`, `photoID=${encodeURIComponent(photoID)}`];
      if (px) q.push(`size=${px}`);
      q.push('version=1');
      return `${location.origin}${path}?${q.join('&')}`;
    };

    return {
      count: fi.photos.length,
      inspectionID,
      photos: fi.photos.map((guid) => ({
        id: guid,
        label: labels[guid] != null ? labels[guid] : null,
        labelValue: labelValues[guid] != null ? labelValues[guid] : null,
        thumbUrl: url(guid, size || 150),
        fullUrl: url(guid, null),
      })),
    };
  }

  // ── Writing ───────────────────────────────────────────────────────

  /**
   * Apply values through the engine.
   *
   * `setValue()` is the engine's own entry point, so visibility rules,
   * calculations, scoring and validation all re-run exactly as they would for
   * a human edit. That is the whole reason this extension drives the engine
   * instead of poking <input> elements.
   *
   * Refuses outright in review / print view - there is nothing to write to.
   * Does NOT save; the caller decides when to persist.
   */
  function setValues(updates) {
    const mode = readMode();
    if (!mode.editable) {
      return {
        ok: false,
        error: 'Form is not editable (review / print view). Open the survey as the assigned inspector to fill it.',
        mode,
        results: [],
      };
    }

    const results = [];
    for (const u of Array.isArray(updates) ? updates : []) {
      const controlID = u && (u.questionId || u.controlID || u.inputElementId);
      const ctrl = controlById(controlID);

      if (!ctrl) {
        results.push({ controlID, ok: false, error: 'Control not found on page' });
        continue;
      }
      if (typeof ctrl.setValue !== 'function') {
        results.push({ controlID, ok: false, error: 'Control has no setValue' });
        continue;
      }
      if (ctrl.hiddenByRules === true || ctrl.hiddenByParent === true) {
        results.push({ controlID, ok: false, error: 'Control is hidden by a form rule' });
        continue;
      }

      const before = safeGetValue(ctrl);
      try {
        ctrl.setValue(u.value);
        results.push({ controlID, ok: true, before, after: safeGetValue(ctrl) });
      } catch (err) {
        results.push({ controlID, ok: false, error: err && err.message ? err.message : String(err) });
      }
    }

    return { ok: true, mode, results };
  }

  /**
   * Persist. `silent` uses the same path the page's own autosave uses.
   * Only ever called on an explicit request from the side panel.
   */
  function save(silent) {
    const F = window.LC360Forms;
    if (!F) return { ok: false, error: 'LC360Forms not available' };

    const mode = readMode();
    if (!mode.editable) return { ok: false, error: 'Form is not editable', mode };

    try {
      if (silent && typeof F.saveLoadedFormSilently === 'function') {
        F.saveLoadedFormSilently();
        return { ok: true, mode: 'silent' };
      }
      if (typeof F.saveLoadedForm === 'function') {
        F.saveLoadedForm();
        return { ok: true, mode: 'normal' };
      }
      return { ok: false, error: 'No save entry point on LC360Forms' };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }

  // ── Dispatch ──────────────────────────────────────────────────────

  // Exposed on window so page/photos-agent.js (also MAIN world) can register
  // its own actions into the same dispatch table and reuse this one bridge.
  const HANDLERS = {
    ping:      () => ({ ok: true, agent: 'nsr-boost', version: 1 }),
    context:   () => context(),
    mode:      () => readMode(),
    extract:   () => extract(),
    photos:    (p) => photos(p),
    setValues: (p) => setValues(p && p.updates),
    save:      (p) => save(!!(p && p.silent)),
  };
  window.__NSR_BOOST_ACTIONS__ = HANDLERS;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== REQ || !msg.action) return;

    const handler = HANDLERS[msg.action];
    let response;

    if (!handler) {
      response = { ok: false, error: `Unknown action: ${msg.action}` };
    } else {
      try {
        response = { ok: true, data: handler(msg.payload) };
      } catch (err) {
        response = { ok: false, error: err && err.message ? err.message : String(err) };
      }
    }

    window.postMessage({ source: RES, id: msg.id, ...response }, '*');
  });

  // Let the isolated world know the agent is live without it having to poll.
  window.postMessage({ source: RES, id: 'ready', ok: true, data: { ready: true } }, '*');
})();
