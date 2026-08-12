/**
 * content/bridge.js - isolated-world half of the page bridge.
 *
 * The engine lives in the page's JS context and is invisible from here, so
 * every engine call is relayed to `page/dynforms-agent.js` (MAIN world) over
 * window.postMessage and awaited by request id.
 *
 * Public API: window.NSR_BRIDGE
 *   ping()               → { agent, version }
 *   context()            → page/form/mode summary
 *   mode()               → editable? review? printView?
 *   extract()            → { items, sections, stats }
 *   photos()             → { photos[], urlTemplate }
 *   setValues(updates)   → { ok, mode, results[] }   updates: [{questionId, value}]
 *   save({ silent })     → { ok, mode }
 *
 * All methods reject with an Error rather than returning a partial result, so
 * callers can use a single try/catch.
 */

(() => {
  if (window.__NSR_BOOST_BRIDGE__) return;
  window.__NSR_BOOST_BRIDGE__ = true;

  const REQ = 'NSR_BOOST_REQ';
  const RES = 'NSR_BOOST_RES';
  const DEFAULT_TIMEOUT_MS = 15000;

  const pending = new Map();
  let seq = 0;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== RES) return;

    const entry = pending.get(msg.id);
    if (!entry) return; // includes the agent's unsolicited 'ready' ping
    pending.delete(msg.id);
    clearTimeout(entry.timer);

    if (msg.ok) entry.resolve(msg.data);
    else entry.reject(new Error(msg.error || 'DynForms agent error'));
  });

  function call(action, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = `nsrb_${Date.now()}_${seq++}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(
          `DynForms agent did not respond to "${action}" within ${timeoutMs}ms. ` +
          'The MAIN-world content script may not have loaded on this page.'
        ));
      }, timeoutMs);

      pending.set(id, { resolve, reject, timer });
      window.postMessage({ source: REQ, id, action, payload }, '*');
    });
  }

  window.NSR_BRIDGE = {
    ping:      () => call('ping', null, 3000),
    context:   () => call('context'),
    mode:      () => call('mode'),
    extract:   () => call('extract', null, 30000),
    photos:    (opts) => call('photos', opts || {}),
    setValues: (updates) => call('setValues', { updates }, 60000),
    save:      (opts) => call('save', { silent: !!(opts && opts.silent) }, 30000),

    // Order/Edit Photos panel (page/photos-agent.js)
    photoPanelState: () => call('photoPanelState', null, 5000),
    extractPanel:    () => call('extractPanel'),
    applyApiResults: (order, labelMap) => call('applyApiResults', { order, labelMap }, 30000),
    restoreOriginal: (labelMap) => call('restoreOriginal', { labelMap }, 30000),
    setPhotoLabel:   (photoId, label) => call('setPhotoLabel', { photoId, label }),
    applyLabelMap:   (labelMap) => call('applyLabelMap', { labelMap }, 30000),
    focusPhoto:      (photoId) => call('focusPhoto', { photoId }),

    /** True when the MAIN-world agent is present and answering. */
    async isAvailable() {
      try {
        await call('ping', null, 3000);
        return true;
      } catch (_) {
        return false;
      }
    },
  };

  console.log('[NSR-Boost] Bridge loaded');
})();
