/**
 * content/generalinfo.js - General Information page extractor.
 *
 * The GI page is *not* a DynForms page - it is a plain server-rendered detail
 * view, so this runs entirely in the isolated world with no bridge involved.
 *
 * Layout is a flat sequence of label/value siblings inside a `.clearfix` grid:
 *
 *   <div class="ri ri-l"><p><label>Policy Number</label></p></div>
 *   <div class="ri">RYO0009420</div>
 *
 * 109 such pairs on the survey used for analysis.
 *
 * Public API: window.NSR_GENERALINFO
 *   isGeneralInfoPage()        → bool
 *   readPairs()                → { [label]: value }
 *   extractFields(whitelist)   → { [backendKey]: value } for the registry list
 *   surveyType()               → the "Survey Type" value ('' when absent)
 *   surveyNumber()             → the "Survey Number" value
 *   headerSurveyNumber()       → the survey number from the page banner,
 *                                which exists on every inspection page
 */

(() => {
  if (window.__NSR_BOOST_GI__) return;
  window.__NSR_BOOST_GI__ = true;

  /**
   * Label renames between the old NSR site and BoostUSA. Keys are the
   * BoostUSA label; values are the key the backend already expects.
   *
   *   NSR                        BoostUSA
   *   "Address to be Inspected" → "Address to be Surveyed"
   *
   * The backend contract emits plain "Address" for this row, unchanged.
   */
  const BACKEND_KEYS = {
    'Address to be Surveyed': 'Address',
    'Address to be Inspected': 'Address',
  };

  function clean(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').replace(/\s*:\s*$/, '').trim();
  }

  /**
   * Multi-line values (addresses) are separated by <br>, which collapses into
   * "1290 Nostrand AvenueBrooklyn, NY" without this. Convert breaks to
   * newlines before reading text.
   */
  function readValue(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    const joined = clone.textContent
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(', ')
      .trim();
    return stripGeocode(joined);
  }

  /**
   * The address row carries a geocoding trailer that NSR never had:
   *   "1290 Nostrand Avenue, Brooklyn, NY, 11226, Kings,
   *    Latitude: 40.65567, Longitude: -73.95027, Match: Rooftop"
   * The backend wants the postal address only.
   */
  function stripGeocode(value) {
    return value
      .replace(/,?\s*(Latitude|Longitude|Match)\s*:\s*[^,]*/gi, '')
      .replace(/\s*,\s*$/, '')
      .trim();
  }

  function isGeneralInfoPage() {
    return document.querySelectorAll('.ri.ri-l').length > 0
        && !document.querySelector('.dyn-mainform');
  }

  /**
   * All label → value pairs on the page. Later duplicates do not clobber
   * earlier, so the survey grid wins over Extra Info on any shared label.
   *
   * Two grids, read in order:
   *
   *   .ri.ri-l  → .ri            the survey detail grid (109 rows): policy,
   *                              survey number, address, dates, agency…
   *   #genFieldSection
   *   .genFieldR.genFieldR-l
   *             → .genFieldR     the "Extra Info" panel (31 rows). Same
   *                              label/value-sibling shape, different classes.
   *
   * The Extra Info panel is where BoostUSA keeps the generic fields NSR served
   * from its Generic Fields table - ConstructionType, YearBuilt, Wiring and the
   * rest of the knowledge-base whitelist. Reading only `.ri.ri-l` missed all of
   * them, which is why the GI payload used to carry Address alone.
   */
  function readPairs() {
    const out = {};

    const add = (label, valueEl) => {
      if (!label || !valueEl) return;
      if (Object.prototype.hasOwnProperty.call(out, label)) return;
      out[label] = readValue(valueEl);
    };

    document.querySelectorAll('.ri.ri-l').forEach((labelEl) => {
      const valueEl = labelEl.nextElementSibling;
      if (!valueEl || !valueEl.classList.contains('ri')) return;
      add(clean(labelEl.textContent), valueEl);
    });

    // Extra Info. `.bg-primary.section-header` divs ("Preferred", "Boost",
    // "SmartFill") sit between rows, so scan forward for the value rather than
    // trusting nextElementSibling - and stop at the next label so a field with
    // no value cell can't borrow the following row's value.
    document.querySelectorAll('#genFieldSection .genFieldR.genFieldR-l').forEach((labelEl) => {
      let el = labelEl.nextElementSibling;
      while (el && !el.classList.contains('genFieldR')) el = el.nextElementSibling;
      if (!el || el.classList.contains('genFieldR-l')) return;
      add(clean(labelEl.textContent), el);
    });

    return out;
  }

  /**
   * Project the page down to the whitelist the registry entry carries.
   * Matching is case-insensitive and prefix-based, same rule as NSR_LMS.
   */
  function extractFields(whitelist) {
    const pairs = readPairs();
    if (!Array.isArray(whitelist) || !whitelist.length) return pairs;

    const out = {};
    for (const want of whitelist) {
      const wantLower = clean(want).toLowerCase();
      const hit = Object.keys(pairs).find((label) => label.toLowerCase().startsWith(wantLower));
      if (!hit) continue;
      out[BACKEND_KEYS[hit] || hit] = pairs[hit];
    }
    return out;
  }

  /**
   * The survey number out of the page banner above the photo rail.
   *
   * `#mainFormTabHeader` is rendered on *every* inspection page - Survey
   * Details, Attach Files and each form - and always carries
   * "Policy: <policy> Survey # :<number>". Verified on all three for survey
   * 22081.
   *
   * This lives here rather than beside the GI readers because it is the only
   * survey-number source that survives on a page with no DynForms engine *and*
   * no `.ri.ri-l` grid - Attach Files being both. Sibling elements run
   * together under textContent ("...RYO0009420 Survey # :22081Policy Holder"),
   * so the pattern anchors on its own label rather than on surrounding
   * whitespace.
   */
  function headerSurveyNumber() {
    const header = document.querySelector('#mainFormTabHeader');
    if (!header) return '';
    const match = header.textContent.match(/Survey\s*#\s*:?\s*(\d+)/i);
    return match ? match[1] : '';
  }

  function lookup(label) {
    const pairs = readPairs();
    const wanted = clean(label).toLowerCase();
    const hit = Object.keys(pairs).find((k) => k.toLowerCase() === wanted);
    return hit ? pairs[hit] : '';
  }

  window.NSR_GENERALINFO = {
    isGeneralInfoPage,
    readPairs,
    extractFields,
    surveyType: () => lookup('Survey Type'),
    surveyNumber: () => lookup('Survey Number'),
    headerSurveyNumber,
  };
})();
