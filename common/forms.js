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
  // The analysis survey reports "Rec Management_Test_1", which is a test
  // value - the real production strings still need confirming. Until then the
  // survey-type filter in matchForm() is advisory: an unknown type does not
  // block a title + section-signature match.
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
      fields: [
        'Areas Reviewed',
        'Underwriter concerns / Inspection comments',
        'Opinion of Risk',
        'Comment',
      ],
      // "Describe" appears twice on this form (once under "Were any critical
      // issues observed?", once under "Past losses learned of?"), so a flat
      // {label: value} dict would silently drop one. Keys collide → qualify
      // with the section/sub-section. See qualifyKey() in content/content.js.
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
      genericFields: ['Address to be Surveyed'],
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

  const api = {
    SURVEY_TYPES,
    SUPPORTED_FORMS,
    isBoostHost,
    isLossControlHost,
    matchForm,
    isSupportedSurveyType,
    normalize,
    capabilitiesForUrl,
  };

  if (typeof window !== 'undefined') window.NSR_FORMS = api;
  else if (typeof self !== 'undefined') self.NSR_FORMS = api;
})();
