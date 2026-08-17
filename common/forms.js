/**
 * common/forms.js - page capability registry for BoostUSA.
 *
 * Same job as the NSR_LMS registry, but keyed differently. On the old site a
 * form was identified by a stable `caseFormID` GUID. On BoostUSA the
 * `inspectionFormID` in the URL is **per-inspection**, not per-form-definition,
 * so it cannot be hard-coded. Detection therefore keys off:
 *
 *   1. the form title (tab header / document title), and
 *   2. a signature of the form's main section headings, as a cross-check.
 *
 * Loaded in the content script (window.NSR_FORMS) and the service worker
 * (self.NSR_FORMS).
 *
 * See docs/PLATFORM-ANALYSIS.md §7.
 */

(function () {
  'use strict';

  // Survey type is the BoostUSA equivalent of NSR's `Utilant.CaseTypeName`.
  //
  // NSR exposed it only as an inline-script global, which the content script
  // had to scrape out of the page source. Here it is a plain property on the
  // loaded form instance and is read directly:
  //
  //     LC360Forms.getLoadedFormInstance()
  //       .engine.formInfo.inspectionInfo.inspectionType
  //
  // That makes it available on every form page rather than only on General
  // Information (see page/dynforms-agent.js → surveyType()).
  //
  // Confirmed live on survey 22035: the engine reports "WKFC Property Standard"
  // verbatim on both WKFC Cover and WKFC: Core Revised, and the General
  // Information grid's "Survey Type" row carries the identical string. The
  // filter in matchForm() is therefore a hard gate, not advisory - see
  // isSupportedSurveyType().
  const SURVEY_TYPES = {
    WKFC: 'WKFC Property Standard',
  };

  const SUPPORTED_FORMS = [
    {
      name: 'WKFC: Core Revised',
      shortName: 'WKFC Core Revised',
      titleHint: 'WKFC: Core Revised',
      flow: 'verify',
      kind: 'form',
      surveyTypes: [SURVEY_TYPES.WKFC],
      // Cross-check: every one of these headings must be present among the
      // page's .dyn-mainSection-title elements. Guards against a title-only
      // match on a differently-built form that happens to share a name.
      sectionSignature: [
        'Operations/Occupancy',
        'Building Information',
        'Common Hazards/Building Services & Utilities',
        'Protection/Security',
      ],
    },

    {
      // ⚠ The BoostUSA cover form is NOT the old NSR cover form.
      //
      // NSR_LMS sent five narrative sections to the knowledge base:
      //   Construction · Common / Special Hazards · Protection ·
      //   Review Of Operations / Occupancy · Underwriter concerns / Inspection comments
      //
      // Of those, only "Underwriter concerns / Inspection comments" still
      // exists here. The BoostUSA cover is a 16-control summary form
      // (Survey Date, Opinion of Risk, contact block, …) with a different set
      // of free-text fields. The whitelist below is what actually exists on
      // the page; whether the backend wants these keys is an open question -
      // see docs/PLATFORM-ANALYSIS.md §8.
      name: 'WKFC Cover',
      shortName: 'WKFC Cover',
      titleHint: 'WKFC Cover',
      flow: 'knowledge_base',
      pageType: 'cover',
      kind: 'form_text_dict',
      surveyTypes: [SURVEY_TYPES.WKFC],
      sectionSignature: ['Survey Information', 'General Information'],
      // The NSR_LMS cover contract, unchanged: these five and nothing else.
      //
      // toTextDict() emits only the entries it actually finds on the page, so a
      // label absent from this survey's cover is left out of the payload
      // entirely rather than sent empty. On BoostUSA today that means exactly
      // one key ships - "Underwriter concerns / Inspection comments" - because
      // the other four narratives do not exist on this cover. They stay listed
      // so they flow through automatically on any tenant or future cover
      // revision that does carry them.
      //
      // The BoostUSA-specific narratives (Areas Reviewed, Opinion of Risk,
      // Comment) were deliberately REMOVED: they are real content on this
      // cover, but they are not part of the /knowledge cover contract and the
      // backend was never asked for them. Re-add them here if that changes.
      fields: [
        'Construction',
        'Common / Special Hazards',
        'Protection',
        'Review Of Operations / Occupancy',
        'Underwriter concerns / Inspection comments',
      ],
      // "Describe" appears twice on this form (once under "Were any critical
      // issues observed?", once under "Past losses learned of?"), so a flat
      // {label: value} dict would silently drop one. Colliding keys are
      // qualified with their sub-section - see toTextDict() in
      // content/content.js.
      //
      // Inert with the whitelist above, since "Describe" is not in it; kept so
      // a future whitelisted label that does repeat cannot overwrite itself.
      // Note the qualification needs `subheader`, which extract() reports as ''
      // on this form - a real collision would fall back to the plain key.
      hasDuplicateLabels: true,
    },

    {
      // Not a DynForms page - a plain server-rendered detail view. Handled by
      // content/generalinfo.js rather than the bridge.
      //
      // The row is labelled "Address to be Surveyed" here; NSR called it
      // "Address to be Inspected". Both map to the backend key "Address".
      name: 'General Information',
      shortName: 'General Information',
      titleHint: 'General Information',
      flow: 'knowledge_base',
      pageType: 'general',
      kind: 'generic_fields',
      isGeneralInfo: true,
      // GI looks identical across survey types, so it needs the same
      // restriction as the forms - otherwise a non-WKFC survey's GI page would
      // still be treated as supported.
      surveyTypes: [SURVEY_TYPES.WKFC],
      // The full NSR_LMS WKFC knowledge-base whitelist. All eleven generic
      // fields exist on BoostUSA, in the "Extra Info" panel (#genFieldSection)
      // rather than the survey grid - see readPairs() in
      // content/generalinfo.js, which walks both.
      //
      // Labels are identical to NSR's apart from the address row, which
      // BoostUSA calls "Address to be Surveyed"; BACKEND_KEYS maps it to the
      // unchanged backend key "Address".
      //
      // Fields absent from a given survey are simply omitted from the payload
      // (extractFields skips a miss) rather than sent empty.
      genericFields: [
        'ConstructionType',
        'NumberStories',
        'NumberOfBuildings',
        'RoofType',
        'Roofing',
        'Sprinklers',
        'YearBuilt',
        'Plumbing',
        'Wiring',
        'Heating',
        'Occupancy',
        'Address to be Surveyed',
      ],
    },
  ];

  // ── Helpers ────────────────────────────────────────────────────────

  function normalize(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  /** Could this hostname host a BoostUSA DynForms page at all? */
  function isBoostHost(hostname) {
    return hostname === 'boostusa.losscontrol360.com';
  }

  /** Any LossControl360 host (photo pages etc. live on sibling hosts). */
  function isLossControlHost(hostname) {
    return typeof hostname === 'string' && hostname.endsWith('losscontrol360.com');
  }

  /**
   * Is this survey type one the extension supports?
   *
   * NSR-Boost is deliberately scoped to **WKFC Property Standard only**. Any
   * other survey type is rejected outright rather than falling through to a
   * title match, so a Brownstone or Condos survey that happens to carry a
   * similarly-named form can never be picked up.
   *
   * An empty type means the page did not report one (e.g. the engine had not
   * loaded yet). That is treated as unknown, not as a pass.
   */
  function isSupportedSurveyType(surveyType) {
    const type = normalize(surveyType).toLowerCase();
    if (!type) return false;
    return Object.values(SURVEY_TYPES).some((x) => normalize(x).toLowerCase() === type);
  }

  /**
   * Match a form title against the registry.
   *
   * Three gates, in order: survey type → title → section signature.
   *
   * @param {string} title            form title from the page
   * @param {string[]} mainSections   .dyn-mainSection-title texts
   * @param {string} surveyType       required; a blank or unknown type fails
   */
  function matchForm(title, mainSections, surveyType) {
    const t = normalize(title).toLowerCase();
    if (!t) return null;

    const sections = (mainSections || []).map((s) => normalize(s).toLowerCase());
    const type = normalize(surveyType);

    if (!isSupportedSurveyType(type)) {
      return {
        form: null,
        matched: false,
        reason: type
          ? `Survey type "${type}" is not supported. This build handles ${SURVEY_TYPES.WKFC} only.`
          : 'Survey type could not be determined for this page.',
        surveyTypeRejected: true,
      };
    }

    for (const form of SUPPORTED_FORMS) {
      if (!t.includes(form.titleHint.toLowerCase())) continue;

      // Per-form survey-type restriction, on top of the global gate above.
      if (Array.isArray(form.surveyTypes) && form.surveyTypes.length) {
        const allowed = form.surveyTypes.some((x) => normalize(x).toLowerCase() === type.toLowerCase());
        if (!allowed) {
          return {
            form,
            matched: false,
            reason: `"${form.name}" is not available for survey type "${type}".`,
            surveyTypeRejected: true,
          };
        }
      }

      const sig = form.sectionSignature || [];
      const missing = sig.filter((want) => !sections.some((s) => s.includes(want.toLowerCase())));
      if (missing.length) {
        return { form, matched: false, reason: `Section signature mismatch: missing ${missing.join(', ')}` };
      }

      return { form, matched: true };
    }
    return null;
  }

  /**
   * Host-level capability check, used by the service worker to decide whether
   * a tab is worth a content-script round-trip and which files to inject.
   * Deliberately URL-only - no DOM access, since this also runs in the worker.
   */
  function capabilitiesForUrl(url) {
    let hostname = '';
    let pathname = '';
    try {
      const u = new URL(url);
      hostname = u.hostname;
      pathname = u.pathname;
    } catch (_) {
      return { hostname: '', form: false, images: false };
    }

    const boost = isBoostHost(hostname);
    return {
      hostname,
      // Inspection detail pages (General Information) and DynForms form pages
      // both live under /Inspection/.
      form: boost && /^\/Inspection(\/|$)/i.test(pathname),
      // Photos ride along with the form page on BoostUSA - the engine's
      // formInfo.photos replaces the old standalone photo-grid page.
      images: boost && /^\/Inspection(\/|$)/i.test(pathname),
    };
  }

  /**
   * Stable identity for a BoostUSA page, for "is this still the page the
   * operation started on?" checks.
   *
   * A raw URL string is not usable for that. The SPA rewrites the address bar,
   * `contextID` changes between visits to the same form, and query parameters
   * are not emitted in a stable order - so `urlA === urlB` reports "different
   * page" for two views of the very same form. What actually identifies a page
   * is the origin, the path, and `inspectionFormID` (the form open in it).
   *
   * Unparseable input is returned trimmed, so a bad URL only ever matches
   * itself.
   */
  function pageKeyOf(url) {
    try {
      const u = new URL(String(url));
      const formId = (u.searchParams.get('inspectionFormID') || '').toLowerCase();
      return `${u.origin}${u.pathname.replace(/\/+$/, '')}${formId ? `#${formId}` : ''}`;
    } catch (_) {
      return String(url == null ? '' : url).trim();
    }
  }

  /** Do two URLs point at the same BoostUSA page? Empty input never matches. */
  function samePage(a, b) {
    if (!a || !b) return false;
    return pageKeyOf(a) === pageKeyOf(b);
  }

  const api = {
    SURVEY_TYPES,
    SUPPORTED_FORMS,
    isBoostHost,
    isLossControlHost,
    matchForm,
    isSupportedSurveyType,
    normalize,
    capabilitiesForUrl,
    pageKeyOf,
    samePage,
  };

  if (typeof window !== 'undefined') window.NSR_FORMS = api;
  else if (typeof self !== 'undefined') self.NSR_FORMS = api;
})();
