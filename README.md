# NSR-Boost

Chrome extension for the **BoostUSA** platform (`boostusa.losscontrol360.com`) —
the successor to the NSR site that `NSR_LMS` targets.

It is a sibling of `NSR_LMS`, not a copy. The backend contract and the side
panel carry over; the page-interaction layer is rebuilt, because BoostUSA
exposes a client-side form engine (`DynForms`) with a real JavaScript API
instead of server-rendered table rows.

Docs: [`CONTEXT.md`](CONTEXT.md) for engineering context and the traps that have
already cost time; [`docs/PLATFORM-ANALYSIS.md`](docs/PLATFORM-ANALYSIS.md) for
the platform itself as observed live.

---

## Scope: WKFC Property Standard only

Every capability — form review, Order Photos, General Information — is gated on
the survey type. Any other survey type is rejected before any other check runs,
so the extension goes completely dark rather than half-working.

The gate is applied in three places, because General Information and the photo
panel do not go through the form matcher:

| Path | Where |
|---|---|
| DynForms form pages | `NSR_FORMS.matchForm()` |
| General Information | `detectForm()` GI branch in `content/content.js` |
| Order Photos | `detectImages(surveyType)` in `content/content.js` |

To support more survey types, add them to `SURVEY_TYPES` in
[`common/forms.js`](common/forms.js). Everything keys off that one object.

---

## Architecture

```
┌─ page/dynforms-agent.js ────────────── MAIN world ──┐
│  window.DynForms · window.LC360Forms                │
│  jQuery.data(el, 'dynControl')                      │
│  extract · setValues · save · photos · mode         │
└──────────────────── window.postMessage ─────────────┘
                              │
┌─ content/bridge.js ───────── ISOLATED world ────────┐
│  promise wrapper, request ids, timeouts             │
└─────────────────────────────────────────────────────┘
                              │
┌─ content/content.js ────────────────────────────────┐
│  chrome.runtime message router (DETECT_PAGE,        │
│  SCRAPE, APPLY_ANSWER, SAVE_FORM, …)                │
└─────────────────────────────────────────────────────┘
                              │
                    side panel · service worker
```

### Why the two worlds

Content scripts run in an isolated world and **cannot see page globals**.
`window.DynForms`, `window.LC360Forms` and the per-field control instances
stored at `jQuery.data(el, 'dynControl')` all live in the page's own context,
so anything that touches the engine must run with `"world": "MAIN"` in the
manifest. `content/bridge.js` is the isolated-world half; the two halves talk
over `window.postMessage` with request ids.

This is the single biggest difference from `NSR_LMS`, where a single-world
content script could do everything by reading the DOM.

### Why drive the engine instead of the DOM

Calling `control.setValue(v)` runs the engine's own code path, so conditional
visibility, calculated fields, scoring, validation and recommendation triggers
all re-fire exactly as they would for a human edit. Clicking `<input>`
elements would bypass some of that and would break outright in the render
modes where no inputs exist at all.

Reading is better too: each control already exposes `questionText`,
`hiddenByRules`, `visible`, `savedValue` and its full option list, so the
extractor does not have to infer any of it from markup.

---

## Status

| Area | State |
|---|---|
| Platform analysis | **Done** — verified live against survey #22081 |
| MAIN-world agent (`page/dynforms-agent.js`) | **Done**, read path verified live |
| Bridge (`content/bridge.js`) | **Done** |
| Message router (`content/content.js`) | **Done** |
| Form registry — WKFC: Core Revised | **Done**, detection verified |
| Form registry — WKFC Cover | **Done**, fields differ from NSR (see below) |
| Form registry — General Information | **Done**, extraction verified |
| Highlighter, manifest | **Done** |
| Service worker | **Adapted** — two-world injection, `capabilitiesForUrl` |
| Photo read path | **Done**, URLs verified to fetch |
| Order Photos — AI sort + labels + restore | **Done**, full round-trip verified live |
| Auth / LMS licence + metering | **Inherited unchanged** from NSR_LMS |
| Backend | `qagent.dhaninfo.ai` — `/verify-direct`, `/knowledge`, `/feedback`, unchanged |
| **Write path** (`setValues` → `save`) | **Written, NOT verified** — needs an editable survey |
| Side panel | **Partially rewired** — photo URLs and inspection-id parsing updated; verify/KB flows untouched and untested end-to-end |
| Photo modal viewer (`imageModal.js`) | **Ported** — endpoint + stacking checked, not yet clicked through |
| Address block + Google / Maps lookup | **Done** — engine-sourced, works on form pages too |
| Survey-type gate (WKFC only) | **Done** — enforced on forms, GI and photos |

### Verified live

Against survey #22081:

**WKFC: Core Revised** — 8 main sections, 37 sub-sections, **339 questions**
(170 text, 89 radio, 67 checkbox, 13 textarea); 39 controls correctly skipped
as hidden by a visibility rule; 0 label or control-resolution failures;
options and selection state via `getCurrentControlItems()`; detection matches
on title + all 4 signature headings.

**General Information** — page detected, 106 label/value pairs read,
Survey Type (`Rec Management_Test_1`) and Survey Number (`22081`) resolved,
address extracted with `<br>` handling and the geocode trailer stripped.

**Photos** — thumbnail (8 KB) and full-res (371 KB) URLs both fetch 200
`image/jpeg` with session cookies.

**Order Photos** — full AI-sort round trip on 50 photos: panel-open detection,
all 50 ids resolved from `tmplItem()`, order reversed and applied exactly,
three labels written and read back, then order *and* labels restored to
snapshot precisely. Template bindings survived every move. Nothing saved.

### Not verified

**The write path.** The survey used for analysis renders in **review / print
view** (`LC360Forms.getIsReview() === true`, `printView === true`,
`isUserInspector === false`), where no input elements exist at all. The agent
detects this and refuses to write with a clear message rather than failing
silently — but `setValue()` → autosave has not been exercised against a live
editable form. See `docs/PLATFORM-ANALYSIS.md` §5.

**The side panel end-to-end.** Its detection/verify/KB flows are inherited
from NSR_LMS and have not been exercised against BoostUSA responses.

### WKFC Cover is not the NSR cover form

NSR_LMS sent five narrative sections to the knowledge base. Only one of them
still exists on BoostUSA:

| NSR field | On BoostUSA |
|---|---|
| Construction | **gone** |
| Common / Special Hazards | **gone** |
| Protection | **gone** |
| Review Of Operations / Occupancy | **gone** |
| Underwriter concerns / Inspection comments | present |

The BoostUSA cover is a 16-control summary form instead (Survey Date, Opinion
of Risk, Red Flags, contact block, Areas Reviewed, …). The registry whitelist
now lists what actually exists, but **whether the backend wants these keys is
an open question** — the `/knowledge` contract was written against the old
five. It also has two controls both labelled "Describe", so `form_text_dict`
qualifies colliding keys with their sub-section.

---

## Loading it

1. `chrome://extensions` → enable Developer mode
2. **Load unpacked** → select this folder
3. Open a BoostUSA inspection form, then open the side panel

`world: "MAIN"` content scripts require Chrome 111+.

---

## Console cheat-sheet

Run these in DevTools **on the BoostUSA page**, not in the side panel — the
side panel is a separate origin and cannot see any of it. Open with `F12` and
make sure the context dropdown says `top`, not an extension frame.

### Everything the extension reads, in one call

```js
window.__NSR_BOOST_ACTIONS__.context()
```

That is the exact object the extension works from — survey type, survey
number, inspection ids, address, mode flags, section list, photo count. Copy it
to the clipboard with:

```js
copy(JSON.stringify(window.__NSR_BOOST_ACTIONS__.context(), null, 2))
```

### The two fields most often asked about

```js
const fi = LC360Forms.getLoadedFormInstance().engine.formInfo;

fi.inspectionInfo.inspectionType          // survey type  → "WKFC Property Standard"
fi.relatedInspections                     // survey number lives here
  .find(r => r.inspectionID === fi.inspectionID).inspectionNumber   // "22081"
```

`formInfo.referenceID` is **not** the survey number — it is a GUID.

### Other raw sources

```js
fi.inspectionInfo                 // division, policyholder, agent, dates
fi.inspectionInfo.locationAddress // {street1, city, region1, region2, postalCode, country}
fi.latitudeLongitude              // geocode used by the Maps button
fi.photos                         // photo GUIDs
fi.photoLabels                    // labels keyed by GUID

DynForms.FormVersions             // the whole form schema
InspectionForms.photoRules        // UseLabelCollections, label list
InspectionID, InspectionFormID, InspectionTypeID, inspectionStatusID
```

### Is the form editable?

```js
window.__NSR_BOOST_ACTIONS__.mode()
// { isReview, printView, renderedInputCount, editable, … }
```

`editable: false` with `renderedInputCount: 0` means review/print view — the
form renders labels only and nothing can be written.

### One field's live control

```js
const c = jQuery('#<controlGUID>').data('dynControl');
c.questionText          // the label
c.getValue()            // current answer
c.getCurrentControlItems()   // [{value, checked}] for radio / checkbox
c.hiddenByRules         // true → hidden by a visibility rule, skipped on extract
```

Control GUIDs are the `id` on each `div.dyn-input-container`, so you can also
click a field in Elements and read its id.

### What would be sent to the backend

```js
window.__NSR_BOOST_ACTIONS__.extract()   // { items, sections, stats }
```

### Order Photos

```js
window.__NSR_BOOST_ACTIONS__.photoPanelState()   // { open, count, useCollections, … }
window.__NSR_BOOST_ACTIONS__.extractPanel()      // tiles, labels, URLs
```

If `__NSR_BOOST_ACTIONS__` is undefined, the MAIN-world scripts have not run:
reload the page, and check the extension is enabled for this host.

---

## Known issue: the platform API key is committed

`common/lmsUsage.js` carries a static `EXTERNAL_API_KEY` literal, and it is in
this repository's history. It is committed knowingly, not by accident — see the
header block in that file for the full reasoning.

**Keep this repository private.** Making it public publishes the key, and
deleting the line later does not help: git history keeps it.

### Why it is there

The `/external/usage` meter authenticates with a static platform key. A browser
extension has nowhere to hide one — anything shipped to the client is readable
by the client — so hiding it better was never the fix.

### What the fix actually is

A proxy. The extension sends its own user JWT to a QA Agent endpoint; that
endpoint holds the platform key server-side and forwards to `/external/usage`.
Only `reportImageUsage()` changes — nothing that calls it cares how the request
is authenticated.

### Before this repository is ever made public

1. Build the proxy endpoint, or move the key to runtime config with no
   in-source default.
2. **Rotate the key.** It has been on disk and in history; treat it as burned.
3. Purge it from history (`git filter-repo`), or start a fresh repository.
4. Scrub `CONTEXT.md` and `docs/PLATFORM-ANALYSIS.md` — both quote live survey
   #22081, including the policyholder's name, company, policy number and
   address. They are `.gitignore`d today for exactly this reason.

### For future projects

Secrets do not go in client code, and a private repository is a delay, not a
control. Read the key from runtime config with no fallback baked into the
source, and put anything that must stay secret behind a server you own.
