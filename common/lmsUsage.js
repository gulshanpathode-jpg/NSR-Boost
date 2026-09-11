/**
 * common/lmsUsage.js - Image-usage metering against the AdminPortal LMS.
 *
 * One job: before Order Photos uploads a batch to the AI pipeline, tell the
 * LMS how many images this licence is about to process, so the licence's
 * running total for the billing cycle stays accurate.
 *
 *   POST /external/usage   { user_id, license_id, image_count }
 *   GET  /external/usage?license_id=...    (current standing, read-only)
 *
 * Both are authenticated with the platform's X-API-Key. That key is no longer
 * a literal in this file - it is fetched at run time from
 *
 *   GET /auth/external-api-key   ->  { "api_key": "..." }
 *
 * which takes the signed-in user's JWT. It originally answered only for
 * SUPER_ADMIN; the backend has since widened it to any user holding a licence,
 * which is what makes this path usable by inspectors at all.
 *
 * ══════════════════════════════════════════════════════════════════════
 * SECURITY - WHAT THIS DESIGN DOES AND DOES NOT BUY
 * ══════════════════════════════════════════════════════════════════════
 *
 * Fixed by fetching at run time and holding the key in memory:
 *   - The key is no longer in the source or in git history, so a repository
 *     leak no longer leaks it.
 *   - It is never written to chrome.storage, so it does not survive a service
 *     worker teardown and `chrome.storage.local.get(null)` does not reveal it.
 *   - The LMS decides per request whether this caller may have it, so a
 *     revoked or downgraded account stops being given one.
 *
 * NOT fixed - the key still reaches the client:
 *   - It arrives in a response body that DevTools -> Network displays, and it
 *     lives in a variable the side panel console can reach. Anyone motivated
 *     still extracts it in about a minute.
 *   - It is still the platform-wide key. Whoever extracts it can write usage
 *     against ANY user_id / license_id and read ANY licence's quota.
 *
 * The real fix remains a proxy: the extension sends its own user JWT to a QA
 * Agent endpoint, and that endpoint - holding the platform key server-side -
 * attaches it and forwards to /external/usage, deriving user_id and license_id
 * from the verified token rather than trusting the request body. Only the two
 * request builders below would change; nothing that calls them cares how the
 * request is authenticated.
 *
 * ROLE GATE
 * The endpoint now answers for any licence-holding user, so the 403 branch
 * below should not fire in normal use. It is kept because it still can - an
 * unlicensed or downgraded account, or a future re-tightening of the gate -
 * and because that failure is otherwise invisible: metering never blocks an
 * upload, so a silent 403 means silent under-billing. It is logged with
 * console.error and surfaced as kind:'no-key' with reason:'role-denied'.
 *
 * Note what widening the gate costs: every inspector can now obtain whatever
 * key this endpoint returns. If that is the shared platform key, it should be
 * treated as public - any licensed user can then write usage against any
 * license_id and read any licence's quota, which is a tenant-isolation
 * problem, not just a secrecy one. If the backend now mints a per-licence,
 * write-scoped key instead, that concern goes away and a leak costs one
 * licence rather than the platform.
 *
 * Loaded as a plain script (the worker uses importScripts, the panel a
 * <script> tag), so it attaches a single global: window/self.NSR_LMS_USAGE.
 */

(function () {
  'use strict';

  // ── Key cache ────────────────────────────────────────────────────────
  //
  // In memory only, deliberately. Persisting to chrome.storage would put the
  // key back on disk where `chrome.storage.local.get(null)` finds it, and
  // would let it outlive the sign-out that is meant to end this install's
  // access. The cost is a refetch after each service worker teardown, which
  // is one small GET on a path that is already awaiting the network.
  const KEY_TTL_MS = 10 * 60 * 1000;

  let cachedKey = null;
  let cachedAt = 0;
  let inFlight = null;       // collapses concurrent fetches
  let lastKeyReason = '';    // why the last fetch produced nothing

  function forgetKey() {
    cachedKey = null;
    cachedAt = 0;
  }

  // The session lives in chrome.storage.local under `lmsSession`. When it is
  // removed or replaced - sign-out, expiry, revocation, a different user - the
  // cached key must not outlive it. Watching storage keeps this decoupled from
  // common/auth.js and works in the worker and the panel alike.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.lmsSession) forgetKey();
    });
  } catch (_) { /* not available in every context */ }

  async function get(key) {
    try {
      const res = await chrome.storage.local.get(key);
      return res ? res[key] : undefined;
    } catch (_) {
      return undefined;
    }
  }

  function auth() {
    return (typeof window !== 'undefined' ? window.NSR_AUTH : self.NSR_AUTH);
  }

  async function base() {
    const a = auth();
    if (a && a.apiBase) {
      try { return await a.apiBase(); } catch (_) { /* fall through */ }
    }
    return 'https://lms.dhaninfo.ai/api/v1';
  }

  // ── Key retrieval ────────────────────────────────────────────────────

  /**
   * Ask the LMS for the platform key.
   *
   * Returns the key string, or '' with `lastKeyReason` set. Never throws:
   * every caller is on the metering path, and metering must not cost an
   * inspector their upload.
   *
   * The key itself is never logged, on any branch.
   */
  async function fetchKey() {
    const a = auth();
    if (!a || typeof a.authedFetch !== 'function') {
      lastKeyReason = 'no-auth-layer';
      return '';
    }

    let res;
    try {
      // authedFetch attaches the bearer token, refreshes once on a 401 and
      // replays - so an expired access token is handled here for free.
      res = await a.authedFetch(`${await base()}/auth/external-api-key`, {
        headers: { Accept: 'application/json' },
      });
    } catch (err) {
      const signedOut = err && err.name === 'NotSignedInError';
      lastKeyReason = signedOut ? 'not-signed-in' : 'network';
      console.warn(
        '[SmartFill] Could not fetch the usage API key:',
        signedOut ? 'not signed in' : (err && err.message) || String(err)
      );
      return '';
    }

    if (res.status === 403) {
      // Valid token, but the LMS will not issue this account a key. Since the
      // endpoint was widened to licence holders this should be rare - an
      // unlicensed account, or the gate having been re-tightened. Either way
      // it will not resolve itself on retry, so it is an error, not a warning.
      lastKeyReason = 'role-denied';
      console.error(
        '[SmartFill] The LMS refused this account the usage API key (403). ' +
        'Image usage will NOT be metered for this user.'
      );
      return '';
    }

    if (!res.ok) {
      lastKeyReason = `http-${res.status}`;
      console.warn(`[SmartFill] Usage API key request failed: HTTP ${res.status}`);
      return '';
    }

    let body = null;
    try { body = await res.json(); } catch (_) { /* may be empty */ }

    const key = body && typeof body.api_key === 'string' ? body.api_key : '';
    if (!key) {
      lastKeyReason = 'malformed-response';
      console.warn('[SmartFill] Usage API key response carried no api_key field.');
      return '';
    }

    lastKeyReason = '';
    return key;
  }

  /**
   * The key to use for /external/usage, or '' when none can be obtained.
   *
   * Order of preference:
   *   1. `lmsExternalApiKey` in chrome.storage.local - a deliberate dev-only
   *      escape hatch for testing without a SUPER_ADMIN account. It does
   *      persist to disk, which is exactly what the run-time fetch avoids, so
   *      it is for local work and never for a shipped install.
   *   2. The in-memory cache, while still inside its TTL.
   *   3. A fresh GET.
   */
  async function apiKey() {
    const override = await get('lmsExternalApiKey');
    if (typeof override === 'string' && override) return override;

    if (cachedKey && (Date.now() - cachedAt) < KEY_TTL_MS) return cachedKey;

    // Single-flight. The photo path can reach this from more than one place at
    // once, and parallel GETs would be parallel chances to 403 and log.
    if (!inFlight) {
      inFlight = fetchKey()
        .then((key) => {
          if (key) {
            cachedKey = key;
            cachedAt = Date.now();
          }
          return key;
        })
        .catch(() => '')
        .finally(() => { inFlight = null; });
    }

    const pending = inFlight;
    return (await pending) || '';
  }

  /**
   * Request headers carrying the platform key, or null when there is no key.
   *
   * Null rather than a header set to an empty value: sending
   * `X-API-Key: undefined` would spend a round trip to earn a 401 and would
   * read in the logs as a server problem rather than the local one it is.
   */
  async function headers(extra = {}) {
    const key = await apiKey();
    if (!key) return null;
    return { ...extra, 'X-API-Key': key };
  }

  // ── Metering ─────────────────────────────────────────────────────────

  /**
   * Record `imageCount` images against the signed-in user's licence.
   *
   * Called immediately BEFORE the Order Photos pipeline upload, so the count
   * reflects what is about to be sent rather than what came back - a pipeline
   * failure after a successful meter write is the acceptable direction to be
   * wrong in, since the images were genuinely submitted for processing.
   *
   * Never throws and never blocks: metering is secondary to the inspector's
   * actual job, and the guide is explicit that quota is a meter, not a gate.
   * A failure here must not cost someone their photo upload.
   *
   * Returns:
   *   { ok: true,  consumed, max, remaining, record }
   *   { ok: false, kind, detail }      kind: 'no-session' | 'no-license'
   *                                         | 'no-key' | 'network' | 'http'
   */
  async function reportImageUsage(imageCount) {
    const n = Number(imageCount);
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, kind: 'skipped', detail: 'image_count must be > 0' };
    }

    const a = auth();
    if (!a) return { ok: false, kind: 'no-session', detail: 'Auth layer unavailable' };

    let session = null;
    try { session = await a.getSession(); } catch (_) { /* treated as absent */ }
    if (!session) return { ok: false, kind: 'no-session', detail: 'Not signed in' };

    // Both ids come from the sign-in pair: user_id from /auth/login, license_id
    // from /license/consume. A session predating this module has no license_id,
    // and the LMS 404s without it, so bail rather than send a broken payload.
    if (!session.userId || !session.license_id) {
      return {
        ok: false,
        kind: 'no-license',
        detail: 'Session is missing user_id or license_id - sign in again',
      };
    }

    const hdrs = await headers({ 'Content-Type': 'application/json' });
    if (!hdrs) {
      return {
        ok: false,
        kind: 'no-key',
        reason: lastKeyReason,
        roleDenied: lastKeyReason === 'role-denied',
        detail: `No usage API key available (${lastKeyReason || 'unknown'})`,
      };
    }

    let res;
    try {
      res = await fetch(`${await base()}/external/usage`, {
        method: 'POST',
        headers: hdrs,
        body: JSON.stringify({
          user_id: session.userId,
          license_id: session.license_id,
          image_count: Math.round(n),
          // recorded_at omitted deliberately - the server's clock is the one
          // that should decide which billing cycle this lands in.
        }),
      });
    } catch (err) {
      return { ok: false, kind: 'network', detail: err.message || 'Network request failed' };
    }

    let body = null;
    try { body = await res.json(); } catch (_) { /* may be empty on error */ }

    if (!res.ok) {
      // 404 user/licence not found, 403 licence belongs to someone else.
      // Both mean the stored session no longer matches the LMS - worth a
      // console note, but not worth interrupting the upload.
      //
      // A 401 means the key we hold is stale or was revoked between the fetch
      // and now; drop it so the next attempt asks for a fresh one.
      if (res.status === 401) forgetKey();
      return {
        ok: false,
        kind: 'http',
        status: res.status,
        detail: (body && body.detail) || `HTTP ${res.status}`,
      };
    }

    return {
      ok: true,
      record: body && body.record,
      consumed: body && body.consumed_images,
      max: body && body.max_images,
      remaining: body && body.remaining_images,
    };
  }

  /**
   * Current standing for this install's licence, without recording anything.
   * Not used by the upload path - kept because it is the only way to show a
   * quota figure in the UI without incrementing it.
   */
  async function getUsage() {
    const a = auth();
    if (!a) return { ok: false, kind: 'no-session' };

    let session = null;
    try { session = await a.getSession(); } catch (_) { /* treated as absent */ }
    if (!session || !session.license_id) return { ok: false, kind: 'no-session' };

    const hdrs = await headers({ Accept: 'application/json' });
    if (!hdrs) {
      return {
        ok: false,
        kind: 'no-key',
        reason: lastKeyReason,
        roleDenied: lastKeyReason === 'role-denied',
      };
    }

    try {
      const url = `${await base()}/external/usage?license_id=${encodeURIComponent(session.license_id)}`;
      const res = await fetch(url, { headers: hdrs });
      if (!res.ok) {
        if (res.status === 401) forgetKey();
        return { ok: false, kind: 'http', status: res.status };
      }
      const body = await res.json();
      return {
        ok: true,
        consumed: body.consumed_images,
        max: body.max_images,
        remaining: body.remaining_images,
      };
    } catch (err) {
      return { ok: false, kind: 'network', detail: err.message };
    }
  }

  const api = { reportImageUsage, getUsage };

  if (typeof window !== 'undefined') window.NSR_LMS_USAGE = api;
  else self.NSR_LMS_USAGE = api;
})();
