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
 * See AdminPortal-Integration-Guide §8-9.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️  SECURITY - THIS KEY MUST BE REPLACED BEFORE ANY WIDE ROLLOUT  ⚠️
 * ══════════════════════════════════════════════════════════════════════
 *
 * EXTERNAL_API_KEY below is the STATIC PLATFORM key, hardcoded here at the
 * project owner's instruction to get this working end to end. Understand
 * exactly what that means before shipping:
 *
 *   - It is NOT scoped to one user or one customer. It is the same key the
 *     company-lookup endpoint uses (guide §5), and it can push usage records
 *     against ANY user_id / license_id pair on the platform, and read ANY
 *     licence's quota.
 *   - An unpacked Chrome extension is plain text to whoever runs it. Every
 *     inspector who installs this build has the key. So does anyone they
 *     hand the folder to.
 *   - This exact mistake has already been made once in this codebase: the
 *     old X-Ext-Key shipped in a public repo and had to be written off as
 *     compromised.
 *
 * The fix is a proxy, not a better hiding place: the extension sends its own
 * user JWT to a QA Agent endpoint, and that endpoint - which holds secrets
 * server-side where they belong - attaches the platform key and forwards to
 * /external/usage. Until that exists, treat this key as public, rotate it on
 * any suspicion, and do not publish this repo.
 *
 * To swap in the proxy later, only `reportImageUsage` below needs to change;
 * nothing that calls it cares how the request is authenticated.
 *
 * Loaded as a plain script (the worker uses importScripts, the panel a
 * <script> tag), so it attaches a single global: window/self.NSR_LMS_USAGE.
 */

(function () {
  'use strict';

  // ⚠️ See the header block. Static platform key - public in practice.
  // Overridable at runtime without a rebuild:
  //   chrome.storage.local.set({ lmsExternalApiKey: '<key>' })
  const EXTERNAL_API_KEY = '6117yjPdsTA0jSaIF_pR8QJWzUGq0gkvfEXOvAEHhJ0';

  async function get(key) {
    try {
      const res = await chrome.storage.local.get(key);
      return res ? res[key] : undefined;
    } catch (_) {
      return undefined;
    }
  }

  async function apiKey() {
    const override = await get('lmsExternalApiKey');
    return (typeof override === 'string' && override) ? override : EXTERNAL_API_KEY;
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

  async function headers(extra = {}) {
    return { ...extra, 'X-API-Key': await apiKey() };
  }

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
   *                                         | 'network' | 'http'
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

    let res;
    try {
      res = await fetch(`${await base()}/external/usage`, {
        method: 'POST',
        headers: await headers({ 'Content-Type': 'application/json' }),
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

    try {
      const url = `${await base()}/external/usage?license_id=${encodeURIComponent(session.license_id)}`;
      const res = await fetch(url, { headers: await headers({ Accept: 'application/json' }) });
      if (!res.ok) return { ok: false, kind: 'http', status: res.status };
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
