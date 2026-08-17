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

| Path | Where | Survey type read from |
|---|---|---|
| DynForms form pages | `NSR_FORMS.matchForm()` | engine only |
| General Information | `detectForm()` GI branch in `content/content.js` | `.ri.ri-l` "Survey Type" row |
| Order Photos | `detectImages(surveyType)` in `content/content.js` | whichever of the two applies |

On a form page the type is read from the engine and **only** the engine —

```js
LC360Forms.getLoadedFormInstance().engine.formInfo.inspectionInfo.inspectionType
```

There is deliberately no DOM fallback there; it would let page markup stand in
for the engine and weaken the gate. General Information is the exception and has
to be — `getLoadedFormInstance()` *throws* on that page, so the display row is
the only source available.

There is **no `Utilant.CaseTypeName`** on BoostUSA and no hidden input carrying
the survey type. That global was NSR-only.

To support more survey types, add them to `SURVEY_TYPES` in
[`common/forms.js`](common/forms.js) and list them in the relevant registry
entries' `surveyTypes` arrays. Note the key is `surveyTypes` here, not
NSR_LMS's `caseTypes` — anything ported across that walks the registry needs
the rename, or it silently sees no survey types at all.

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
| Form registry — General Information | **Done** — full 12-key knowledge-base payload, verified live |
| Highlighter, manifest | **Done** |
| Service worker | **Adapted** — two-world injection, `capabilitiesForUrl` |
| Photo read path | **Done**, URLs verified to fetch |
| Order Photos — AI sort + labels + restore | **Done**, full round-trip verified live |
| Auth / LMS licence + metering | **Inherited unchanged** from NSR_LMS |
| Backend | `qagent.dhaninfo.ai` — `/verify-direct`, `/knowledge`, `/feedback`, unchanged |
| **Write path** — `setValues` | **Done**, verified live on an editable Cover form (see below) |
| **Write path** — `save` | **Written, NOT verified** — no explicit save has been fired yet |
| Side panel | **Partially rewired** — photo URLs and inspection-id parsing updated; verify/KB flows untouched and untested end-to-end |
| Photo modal viewer (`imageModal.js`) | **Ported** — endpoint + stacking checked, not yet clicked through |
| Address block + Google / Maps lookup | **Done** — engine-sourced, works on form pages too |
| Survey-type gate (WKFC only) | **Done** — enforced on forms (engine only), GI and photos |

### Verified live

Against survey #22081:

**WKFC: Core Revised** — 8 main sections, 37 sub-sections, **339 questions**
(170 text, 89 radio, 67 checkbox, 13 textarea); 39 controls correctly skipped
as hidden by a visibility rule; 0 label or control-resolution failures;
options and selection state via `getCurrentControlItems()`; detection matches
on title + all 4 signature headings.

**General Information** — page detected, 106 label/value pairs read, Survey Type
and Survey Number (`22081`) resolved, address extracted with `<br>` handling and
the geocode trailer stripped.

Against survey #22035:

**Survey type** — the engine reports `"WKFC Property Standard"` verbatim on both
WKFC Cover and WKFC: Core Revised, and the GI "Survey Type" row carries the
identical string. The production value matches `SURVEY_TYPES.WKFC` exactly, so
the gate is a hard equality check rather than the advisory filter it started as.

**General Information** — 139 label/value pairs across both grids (the survey
detail grid and the Extra Info panel, see below), emitting all **12**
knowledge-base keys: ConstructionType, NumberStories, NumberOfBuildings,
RoofType, Roofing, Sprinklers, YearBuilt, Plumbing, Wiring, Heating, Occupancy
and Address.

**WKFC Cover** — 16 questions extracted; the whitelist emits the single NSR
contract field that exists here and omits the four that do not.

**Order Photos** — opens on all three pages (General Information, Cover, Core
Revised) with the same 17 items and `UseLabelCollections: false`. Note the
engine equation above does **not** hold on General Information — the button and
dialog work there, but `getLoadedFormInstance()` throws, which is why the photo
gate falls back to the GI display row on that page.

### General Information has two grids

The generic fields NSR served from its Generic Fields table live in the **Extra
Info** panel on BoostUSA, under different classes:

| Grid | Label | Value | Rows on 22035 |
|---|---|---|---|
| survey detail | `.ri.ri-l` | `.ri` | 109 |
| Extra Info (`#genFieldSection`) | `.genFieldR.genFieldR-l` | `.genFieldR` | 31 |

`readPairs()` walks both, survey grid first (it wins on any shared label).
Reading only `.ri.ri-l` was why the GI payload used to carry the address alone.

The same data is also on `formInfo.genericFields` as
`{ label: { actualValue, formattedValue } }`, which is cleaner and works on form
pages too — unused, because GI has no engine and would need the DOM path anyway.

**Photos** — thumbnail (8 KB) and full-res (371 KB) URLs both fetch 200
`image/jpeg` with session cookies.

**Order Photos** — full AI-sort round trip on 50 photos: panel-open detection,
all 50 ids resolved from `tmplItem()`, order reversed and applied exactly,
three labels written and read back, then order *and* labels restored to
snapshot precisely. Template bindings survived every move. Nothing saved.

### The write path, verified live

Against an **editable** WKFC Cover form (`getIsReview() === false`,
`printView === false`, 56 rendered inputs, `inspectionStatusID` 700). Note that
`isUserInspector` and `getIsFieldRep()` were both `false` here and the form was
still editable — which is exactly why `readMode().editable` trusts the rendered
input count over the role flags.

`setValues` writes correctly through the engine on radio and checkbox controls,
and reads back through `getValue()`. **`save` has still not been fired** —
neither `saveLoadedFormSilently()` nor `saveLoadedForm()` has been exercised, so
persistence is verified no further than the in-page model.

**`CheckBoxList.setValue()` is additive.** This is the one real trap the write
path hides, and it cost a live bug. The engine's implementation ticks every
label it is handed and unticks nothing:

```js
if (value == null) { $('input', this.table).prop('checked', false); return; }
for (each label in value)
  $('input[value="' + label + '"]', this.table).prop('checked', true).length
    || this.addItem(label, true);
```

So writing `['B']` over a control already holding `['A', 'C']` yields all three.
`setValue(null)` is the only branch that clears, so `setValues()` clears first
on multi-select controls — see `isMultiSelect()` in `page/dynforms-agent.js`.
This affected accept **and** revert; both are fixed and verified.

Radio lists are not affected: they render as real `<input type="radio">` sharing
one `name`, so the browser unticks the previous choice itself. Single boolean
checkboxes are not affected either — their `setValue` branch writes `!!value`.

### Not verified

**Rule re-firing on an AI-applied answer.** `setValue()` sets inputs via jQuery
`.prop('checked', …)`, which fires no `change` event. Whether dependent
visibility rules, calculations and scoring re-run on a programmatic write the
way they do for a human click is **untested**.

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
of Risk, Red Flags, contact block, Areas Reviewed, …). It also has two controls
both labelled "Describe", so `form_text_dict` qualifies colliding keys with
their sub-section.

The registry `fields` list holds **the NSR five and nothing else**.
`toTextDict()` filters the page's questions *by* the whitelist, so a label that
is not on the form never becomes a key — nothing is ever sent empty. The four
missing narratives stay listed so they flow through automatically on any tenant
or cover revision that does carry them.

Verified on 22035 — the cover POSTs exactly one key:

```
Underwriter concerns / Inspection comments      (391 chars)
```

The cover's own narratives — `Areas Reviewed`, `Opinion of Risk`, `Comment` —
were in the whitelist and have been removed. They are the real narrative content
of this form, but they are not part of the `/knowledge` cover contract and the
backend was never asked for them. Re-add them to `fields` if that changes.

So the cover flow currently carries a single field to the knowledge base. If
that is too thin to be worth a POST, the fix is a backend conversation about
accepting the BoostUSA keys, not an extension change.

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
