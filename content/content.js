/**
 * content/content.js - message router for the side panel / service worker.
 *
 * Everything that touches the form goes through window.NSR_BRIDGE
 * (content/bridge.js → page/dynforms-agent.js). Nothing here reads or writes
 * form inputs directly; the DOM is only consulted for detection and scrolling.
 *
 * Action names are kept identical to NSR_LMS so the side panel port carries
 * over unchanged, with two additions: SAVE_FORM and GET_MODE.
 */

(() => {
  if (window.__NSR_BOOST_CONTENT__) return;
  window.__NSR_BOOST_CONTENT__ = true;

  const FORMS = window.NSR_FORMS;
  const bridge = () => window.NSR_BRIDGE;

  // ── Detection ──────────────────────────────────────────────────────

  /**
   * Ask the agent what form this is, then match it against the registry.
   * Returns a shape compatible with the NSR_LMS DETECT_FORM response.
   *
   * The General Information page is handled first and separately: it is a
   * plain server-rendered detail view with no DynForms engine on it, so the
   * bridge would only report "no form open".
   */
  async function detectForm() {
    const GI = window.NSR_GENERALINFO;
    if (GI && GI.isGeneralInfoPage()) {
      const entry = FORMS.SUPPORTED_FORMS.find((f) => f.isGeneralInfo);
      if (!entry) return { supported: false, reason: 'No General Information registry entry' };

      // GI does not go through matchForm (no DynForms engine, no section
      // signature), so the survey-type gate has to be applied here too -
      // otherwise a non-WKFC survey's GI page would still report supported.
      const type = GI.surveyType();
      if (!FORMS.isSupportedSurveyType(type)) {
        return {
          supported: false,
          reason: type
            ? `Survey type "${type}" is not supported. This build handles ${FORMS.SURVEY_TYPES.WKFC} only.`
            : 'Survey type could not be read from this page.',
          caseTypeName: type,
          surveyTypeRejected: true,
        };
      }

      return {
        supported: true,
        form: entry,
        formTitle: entry.name,
        caseTypeName: type,
        surveyNumber: GI.surveyNumber(),
        mode: { editable: false, isGeneralInfo: true },
      };
    }

    const b = bridge();
    if (!b) {
      return { supported: false, reason: 'Bridge not loaded' };
    }

    let ctx;
    try {
      ctx = await b.context();
    } catch (err) {
      return { supported: false, reason: err.message };
    }

    if (!ctx.hasDynForms) {
      return { supported: false, reason: 'No DynForms engine on this page', context: ctx };
    }
    if (!ctx.hasRootForm) {
      return { supported: false, reason: 'No form is open on this page', context: ctx };
    }

    // On a form page the survey type is read from the engine and ONLY from the
    // engine:
    //
    //   LC360Forms.getLoadedFormInstance()
    //     .engine.formInfo.inspectionInfo.inspectionType
    //
    // (page/dynforms-agent.js → surveyType()). That value is authoritative and
    // verified to read "WKFC Property Standard" verbatim on both WKFC Cover and
    // WKFC: Core Revised, so a form whose engine reports anything else - or
    // reports nothing - is not supported. There is deliberately no DOM fallback
    // here: it would let page markup stand in for the engine and weaken the
    // gate. General Information keeps its own DOM read above, because that page
    // carries no engine at all (getLoadedFormInstance() throws there).
    const surveyType = ctx.surveyType || '';
    const match = FORMS.matchForm(ctx.formTitle, ctx.mainSections, surveyType);

    if (!match) {
      return {
        supported: false,
        reason: `Unrecognised form: "${ctx.formTitle}"`,
        context: ctx,
      };
    }
    if (!match.matched) {
      return { supported: false, reason: match.reason, form: match.form, context: ctx };
    }

    return {
      supported: true,
      form: match.form,
      formTitle: ctx.formTitle,
      caseTypeName: surveyType,
      surveyNumber: ctx.surveyNumber,
      inspectionID: ctx.inspectionID,
      inspectionFormID: ctx.inspectionFormID,
      referenceID: ctx.referenceID,
      inspection: ctx.inspection,
      mode: ctx.mode,
      context: ctx,
    };
  }

  /**
   * Fallback only: Survey Type as displayed on the General Information page.
   * Prefer `context.surveyType` from the engine - this exists for GI pages,
   * where there is no DynForms instance to read it from.
   */
  function surveyTypeFromDom() {
    const GI = window.NSR_GENERALINFO;
    if (GI && GI.isGeneralInfoPage()) return GI.surveyType();
    return '';
  }

  /**
   * Fallback only: the survey number as rendered on the page.
   *
   * Two sources, most specific first:
   *
   *   GI grid      the "Survey Number" row - Survey Details page only
   *   page banner  "Survey # :22081" in #mainFormTabHeader, which every
   *                inspection page carries directly above the photo rail
   *
   * Prefer `context.surveyNumber` from the engine: that is the inspection's
   * own record (`relatedInspections[]` matched on inspectionID), not a display
   * string that happens to parse.
   */
  function surveyNumberFromDom() {
    const GI = window.NSR_GENERALINFO;
    if (!GI) return '';

    if (GI.isGeneralInfoPage()) {
      const fromGrid = GI.surveyNumber();
      if (fromGrid) return fromGrid;
    }
    return GI.headerSurveyNumber();
  }

  /**
   * Backfill survey identity onto an EXTRACT_IMAGES response.
   *
   * page/photos-agent.js reads `surveyNumber` / `surveyType` off the DynForms
   * engine, but the ORDER button also exists on the Survey Details and Attach
   * Files pages, where `LC360Forms.getLoadedFormInstance()` *throws*
   * ("No form is currently loaded.") rather than returning null. The agent
   * catches that and degrades to '', so the image upload used to POST
   * `survey_number=''` and the pipeline had nothing to key the batch on.
   *
   * The failure is silent and page-dependent: open the panel from a form page
   * and the number is there; open it from Survey Details - where the photo
   * capability is gated on a survey type read from *this* DOM, and so lights
   * up normally - and it is blank.
   *
   * Both values are on the server-rendered DOM of those pages, which this
   * isolated-world script can read and the MAIN-world agent cannot. Applied to
   * the NOT_ORDER_PHOTOS_PAGE shape too, which carries the same `meta`.
   */
  function withSurveyIdentity(resp) {
    if (!resp || !resp.meta) return resp;

    const meta = { ...resp.meta };
    if (!meta.surveyNumber) meta.surveyNumber = surveyNumberFromDom();
    if (!meta.surveyType) meta.surveyType = surveyTypeFromDom();

    return { ...resp, meta };
  }

  /**
   * Capability snapshot for the side panel.
   *
   * The Order/Edit Photos dialog is modal - while it is open the form behind
   * it is not interactive, so reporting both capabilities would let the panel
   * offer a Sync run against a form the inspector cannot see or edit.
   *
   * So the two capabilities are made mutually exclusive:
   *
   *   panel open   → images supported, form suppressed
   *                  (side panel shows "Order Photos · N images" and only the
   *                   photo tools, because that is what it renders when the
   *                   images capability is the only one available)
   *   panel closed → images unsupported, form detected normally
   *
   * The form detection still runs while the panel is open, so the suppressed
   * entry can carry the real form name for the panel to restore on close.
   */
  async function detectPage() {
    // Form first: its survey type gates the photo capability too, so that a
    // non-WKFC survey has no working feature at all.
    const form = await detectForm();
    const images = await detectImages(form.caseTypeName);

    const shadowed = images.supported
      ? {
          supported: false,
          reason: 'The Order/Edit Photos panel is open. Close it to work on the form.',
          shadowedByPhotoPanel: true,
          // Preserved so the panel can show what it will return to.
          formTitle: form.formTitle || (form.form && form.form.name) || '',
          caseTypeName: form.caseTypeName || '',
        }
      : form;

    return {
      url: window.location.href,
      title: document.title,
      hostname: window.location.hostname,
      caseTypeName: form.caseTypeName || '',
      form: shadowed,
      images,
      generalInfo: generalInfoBlock(form),
      hasFormQuestions: document.querySelectorAll('.dyn-input-container').length > 0,
    };
  }

  /**
   * The address block the side panel renders (copy / Google / Google Maps).
   *
   * `renderAddressBlock()` keys off `detection.generalInfo.address` and hides
   * the block when it is empty - which is why the Maps button was missing
   * until this was emitted.
   *
   * Two sources, engine first:
   *
   *   form page → engine `inspectionInfo.locationAddress`, already structured
   *               into {street, city, region, postalCode} with lat/long
   *               alongside. No scraping, no geocode trailer to strip.
   *   GI page   → the "Address to be Surveyed" row, since GI has no engine.
   *
   * Note this is a widening from NSR_LMS, where the block only ever appeared
   * on General Information. The engine carries the address on every form page,
   * so the inspector can reach Maps without navigating back to GI.
   */
  function generalInfoBlock(form) {
    const GI = window.NSR_GENERALINFO;
    const isGeneralInfo = !!(GI && GI.isGeneralInfoPage());

    if (isGeneralInfo) {
      const fields = GI.extractFields(['Address to be Surveyed']);
      return { isGeneralInfo: true, address: fields.Address || '', source: 'general-info-page' };
    }

    // `inspection` sits on the detection when the form matched the registry,
    // and on `context` otherwise - the address should show on any form page,
    // supported or not (Wildfire Addendum, an unrecognised form, and so on).
    const inspection = (form && form.inspection)
      || (form && form.context && form.context.inspection)
      || null;

    const address = inspection && inspection.address;
    if (address && address.formatted) {
      return {
        isGeneralInfo: false,
        address: address.formatted,
        parts: address,
        latitude: inspection.latitude,
        longitude: inspection.longitude,
        source: 'engine',
      };
    }

    return { isGeneralInfo: false, address: '' };
  }

  /**
   * Order Photos capability.
   *
   * Gated on the Order/Edit Photos dialog being *open*, not merely present:
   * closing it leaves #orderDialog in the DOM with every tile intact, so a
   * presence check would report "supported" forever after the first open.
   *
   * This is also the behaviour asked for - the feature should only light up
   * once the inspector has opened the panel via the ORDER button.
   */
  async function detectImages(surveyType) {
    const b = bridge();
    if (!b) return { supported: false, reason: 'Bridge not loaded' };

    // Same restriction as the forms - this build is WKFC Property Standard
    // only, and that includes the photo tooling.
    if (!FORMS.isSupportedSurveyType(surveyType)) {
      return {
        supported: false,
        reason: surveyType
          ? `Survey type "${surveyType}" is not supported. This build handles ${FORMS.SURVEY_TYPES.WKFC} only.`
          : 'Survey type could not be determined for this page.',
        surveyTypeRejected: true,
      };
    }

    try {
      const state = await b.photoPanelState();
      if (!state.open) {
        return {
          supported: false,
          reason: 'Open the Order/Edit Photos panel (ORDER button above the photo rail).',
          panelOpen: false,
        };
      }
      return state.count > 0
        ? { supported: true, count: state.count, panelOpen: true, useCollections: state.useCollections }
        : { supported: false, reason: 'No photos in the panel', panelOpen: true };
    } catch (err) {
      return { supported: false, reason: err.message };
    }
  }

  // ── Message router ─────────────────────────────────────────────────
  //
  // Every handler is async (the bridge is promise-based), so each case
  // returns true to keep the sendResponse channel open.

  const HANDLERS = {
    DETECT_PAGE: () => detectPage(),
    DETECT_FORM: () => detectForm(),
    GET_MODE: () => bridge().mode(),

    /**
     * Build the backend payload for whichever page we are on.
     *
     * kind: 'generic_fields'  → flat {key: value} from the GI display rows
     * kind: 'form_text_dict'  → flat {label: value} from a DynForms form
     * kind: 'form'            → the full items[]/sections[] verify payload
     *
     * IMPORTANT - response shape:
     *   The service worker reads `items`, `sections`, `stats` and `kbData`
     *   **at the top level** of this response (see background.js
     *   SCRAPE_AND_VERIFY → callVerifyApi(scraped.surveyNumber,
     *   scraped.items, …)). They must not be nested under a `data` key, or
     *   the verify POST goes out with no form data at all and the side panel
     *   gets an undefined section list.
     */
    async SCRAPE() {
      const detection = await detectForm();
      if (!detection.supported) {
        return { success: false, error: detection.reason || 'Unsupported page' };
      }

      const form = detection.form;
      const kind = form.kind || 'form';
      const base = {
        success: true,
        // The engine's own survey number. NOT referenceID - that is a GUID.
        surveyNumber: detection.surveyNumber || null,
        surveyType: detection.caseTypeName || '',
        form,
        flow: form.flow || 'verify',
        kind,
        pageType: form.pageType || '',
        mode: detection.mode,
        extractedAt: new Date().toISOString(),
        sourceUrl: window.location.href,
      };

      // ── kind: "generic_fields" (General Information → knowledge base) ──
      if (kind === 'generic_fields') {
        const GI = window.NSR_GENERALINFO;
        if (!GI) return { success: false, error: 'General Information extractor not loaded' };
        const dict = GI.extractFields(form.genericFields);
        return { ...base, kbData: dict, stats: { fields: Object.keys(dict).length } };
      }

      const extracted = await bridge().extract();

      // ── kind: "form_text_dict" (Cover → knowledge base) ───────────────
      if (kind === 'form_text_dict') {
        const dict = toTextDict(extracted, form);
        return { ...base, kbData: dict, stats: { fields: Object.keys(dict).length } };
      }

      // ── kind: "form" (Core Revised → verify) ──────────────────────────
      // Spread so items / sections / stats land at the top level.
      return { ...base, ...extracted };
    },

    async APPLY_ANSWER(msg) {
      const value = toEngineValue(msg.question, msg.aiItem);
      if (value === undefined) {
        return { ok: false, error: 'No AI answer to apply' };
      }
      const res = await bridge().setValues([
        { questionId: msg.question.questionId, value },
      ]);
      const first = res.results && res.results[0];
      if (!res.ok) return { ok: false, error: res.error, mode: res.mode };
      return first && first.ok
        ? { ok: true, applied: value, before: first.before }
        : { ok: false, error: (first && first.error) || 'setValue failed' };
    },

    async REVERT_ANSWER(msg) {
      // The captured original answer, in the same shape the engine expects.
      const q = msg.question || {};
      const original = q.inputType === 'checkbox'
        ? (q.options || []).filter((o) => o.selected).map((o) => o.label)
        : (q.answer != null ? q.answer : '');
      const res = await bridge().setValues([{ questionId: q.questionId, value: original }]);
      const first = res.results && res.results[0];
      return first && first.ok ? { ok: true } : { ok: false, error: (first && first.error) || res.error };
    },

    async SAVE_FORM(msg) {
      return bridge().save({ silent: msg && msg.silent !== false });
    },

    async GET_PHOTOS() {
      return bridge().photos();
    },

    /**
     * Photo list for the Order Photos flow.
     *
     * Reads the *open* Order/Edit Photos panel, because that is the only place
     * labels can be edited and order can be staged. Returns the same
     * NOT_ORDER_PHOTOS_PAGE error code NSR_LMS used, so the side panel's
     * existing "navigate to Order Photos" branch keeps working - here it means
     * "click the ORDER button to open the panel".
     *
     * `withSurveyIdentity` fills in survey number / type when the panel was
     * opened from a page with no DynForms engine - see its comment.
     */
    async EXTRACT_IMAGES() {
      try {
        return withSurveyIdentity(await bridge().extractPanel());
      } catch (err) {
        return { error: err.message };
      }
    },

    /** Is the Order/Edit Photos panel open right now? Drives capability gating. */
    async PHOTO_PANEL_STATE() {
      return bridge().photoPanelState();
    },

    /** AI sort: `results` is the API response; order comes from its photoId sequence. */
    async APPLY_API_RESULTS(msg) {
      const order = (msg.results || []).map((r) => r.photoId).filter(Boolean);
      return bridge().applyApiResults(order, msg.labelMap);
    },

    async RESTORE_IMAGES(msg) {
      return bridge().restoreOriginal(msg && msg.labelMap);
    },

    async SET_IMAGE_LABEL(msg) {
      return bridge().setPhotoLabel(msg.photoId, msg.label);
    },

    async SET_IMAGE_LABELS_BULK(msg) {
      return bridge().applyLabelMap(msg.labelMap);
    },

    async FOCUS_IMAGE(msg) {
      return bridge().focusPhoto(msg.photoId);
    },

    /**
     * Open the full-resolution viewer on the page.
     *
     * `images` is the gallery (URL array); `imageUrl` is the legacy
     * single-image form, still accepted. `index` is the start position.
     */
    SHOW_IMAGE_MODAL(msg) {
      if (!window.NSR_IMAGE_MODAL) {
        return { ok: false, error: 'Image modal not loaded on this page' };
      }
      const gallery = Array.isArray(msg.images)
        ? msg.images
        : (msg.imageUrl ? [msg.imageUrl] : []);
      const ok = window.NSR_IMAGE_MODAL.show(gallery, msg.index || 0);
      return ok ? { ok: true } : { ok: false, error: 'No image URL' };
    },

    /**
     * Warm the on-page image cache (fire-and-forget). The side panel sends
     * this once a queue is ready so the viewer opens instantly on click.
     */
    PREFETCH_IMAGES(msg) {
      if (!window.NSR_IMAGE_MODAL || typeof window.NSR_IMAGE_MODAL.prefetch !== 'function') {
        return { ok: false, error: 'Image modal not loaded on this page' };
      }
      window.NSR_IMAGE_MODAL.prefetch(msg.images || []);
      return { ok: true };
    },

    /**
     * Fetch an image as a data URL from the page context.
     *
     * The request must originate here rather than in the side panel: the image
     * endpoint is session-authenticated and same-origin with the page, so the
     * cookies ride along automatically.
     */
    async FETCH_IMAGE_BLOB(msg) {
      const res = await fetch(msg.imageUrl, { credentials: 'include' });
      if (!res.ok) throw new Error(`Image fetch returned ${res.status}`);
      const blob = await res.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read image blob'));
        reader.readAsDataURL(blob);
      });
      return { ok: true, dataUrl, type: blob.type, size: blob.size };
    },

    FOCUS_QUESTION(msg) {
      // The side panel sends `questionUid`; the agent's own callers send
      // `questionId`. On BoostUSA both are the control GUID.
      const id = msg.questionUid || msg.questionId;
      const el = id ? document.getElementById(id) : null;
      if (!el) return { ok: false, error: 'Control not found' };
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (window.NSR_HIGHLIGHTER) window.NSR_HIGHLIGHTER.flash(el);
      return { ok: true };
    },
  };

  function photoMeta(detection, photos) {
    return {
      surveyNumber: detection.surveyNumber || '',
      surveyType: detection.caseTypeName || '',
      inspectionID: (photos && photos.inspectionID) || detection.inspectionID || '',
      photoCount: photos ? photos.count : 0,
    };
  }

  /**
   * Project extracted sections down to a flat {label: value} dict, keeping
   * only the labels in the registry entry's `fields` whitelist (prefix match,
   * case-insensitive - same rule as NSR_LMS).
   *
   * Forms flagged `hasDuplicateLabels` qualify colliding keys with their
   * sub-section ("Past losses learned of? › Describe") so a repeated label
   * cannot silently overwrite an earlier answer. Only *colliding* keys are
   * qualified; unique labels keep their plain form so the backend contract is
   * unchanged wherever it already worked.
   */
  function toTextDict(extracted, form) {
    const whitelist = (form.fields || []).map((f) => f.toLowerCase());
    const questions = (extracted.sections || []).flatMap((s) => s.questions || []);

    const wanted = whitelist.length
      ? questions.filter((q) => whitelist.some((w) => q.questionText.toLowerCase().startsWith(w)))
      : questions;

    const seen = new Map();
    for (const q of wanted) seen.set(q.questionText, (seen.get(q.questionText) || 0) + 1);

    const out = {};
    for (const q of wanted) {
      const collides = form.hasDuplicateLabels && seen.get(q.questionText) > 1;
      const key = collides && q.subheader
        ? `${q.subheader} › ${q.questionText}`
        : q.questionText;
      out[key] = Array.isArray(q.answer) ? q.answer.join(', ') : (q.answer == null ? '' : String(q.answer));
    }
    return out;
  }

  /**
   * Translate an AI response item into a value the engine accepts.
   *   radio/select → the selected option label (string)
   *   checkbox     → array of selected option labels
   *   text/textarea→ the answer string
   * Returns undefined when the AI produced nothing usable.
   */
  function toEngineValue(question, aiItem) {
    const ai = aiItem || {};
    const type = question && question.inputType;

    if (type === 'checkbox') {
      const opts = ai.options || question.options || [];
      return opts
        .filter((o) => (o.aiSelected !== undefined ? o.aiSelected : o.selected))
        .map((o) => o.label);
    }

    if (type === 'radio' || type === 'select') {
      const opts = ai.options || question.options || [];
      const target = opts.find((o) => o.aiSelected === true) || opts.find((o) => o.selected === true);
      return target ? target.label : undefined;
    }

    const v = ai.aiAnswer != null ? ai.aiAnswer : ai.answer;
    if (v == null || v === 'null') return undefined;
    return String(v);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const handler = HANDLERS[msg && msg.action];
    if (!handler) return false;

    Promise.resolve()
      .then(() => handler(msg))
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, success: false, error: err.message || String(err) }));

    return true; // async response
  });

  // ── Panel-open watcher ─────────────────────────────────────────────
  //
  // The Order/Edit Photos dialog is created once and then shown/hidden, so
  // nothing navigates and the service worker's tabs.onUpdated broadcast never
  // fires. Without this the side panel would keep showing whatever capability
  // state it saw when the page first loaded.
  //
  // Watching attribute changes on the dialog wrapper (jQuery UI toggles
  // `display` on it) is enough; the check itself is a cheap visibility test.

  let lastPanelOpen = null;

  function panelIsVisible() {
    const el = document.getElementById('orderDialog');
    return !!(el && el.offsetParent !== null);
  }

  const notifyPanelChange = debounce(() => {
    const open = panelIsVisible();
    if (open === lastPanelOpen) return;
    lastPanelOpen = open;
    // Ask the service worker to re-run detection and push it to the panel.
    chrome.runtime.sendMessage({ action: 'REQUEST_DETECTION' }).catch(() => {
      // No listener (side panel closed) - nothing to do.
    });
  }, 200);

  function debounce(fn, ms) {
    let t = null;
    return () => {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  new MutationObserver(notifyPanelChange).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['style', 'class'],
  });

  console.log('[NSR-Boost] Content script loaded');
})();
