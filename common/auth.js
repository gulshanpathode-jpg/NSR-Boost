/**
 * common/auth.js - LMS licence + authentication layer.
 *
 * Owns the answer to "is this person allowed to use Smart Fill at all?".
 * Distinct from common/usage.js, which owns "who is using it" for attribution:
 * usage tracking is best-effort and must never block work, whereas this layer
 * deliberately does block it.
 *
 * Design:
 *   - The AdminPortal LMS holds the accounts, licences and device bindings.
 *     POST /license/validate checks password, licence status, customer status
 *     and expiry, binds this installation to a seat, and returns a JWT. One
 *     call, one answer - the extension never re-implements any of that logic.
 *   - The access token (30 min) is attached to every backend call. The refresh
 *     token (7 days) buys a new one without re-prompting.
 *   - Tokens live in chrome.storage.local.
 *
 * On that last point: the integration guide says to hold the access token "in
 * memory, not in a content script or synced storage". The two things it names
 * are the real risks and we honour both - nothing here is ever passed to a
 * content script (those share a process with untrusted page code), and nothing
 * uses chrome.storage.sync (which would replicate a bearer token to every
 * machine the user signs into Chrome on).
 *
 * Memory-only is the part we do not follow, deliberately. An MV3 service worker
 * is torn down after ~30s idle and the side panel closes with the tab, so
 * "memory" survives minutes at a time; honouring it literally means a password
 * prompt several times a day, and the predictable result is people writing
 * their password down. chrome.storage.local is extension-private, not synced,
 * and not reachable from page JavaScript. It is where the refresh token has to
 * live regardless - keeping the access token elsewhere would buy nothing while
 * costing a refresh round-trip on every worker restart.
 *
 * The `installation_id` below is the load-bearing value. One device consumes
 * one licence (devices.license_id is unique-constrained server-side), so if
 * this id is regenerated the LMS sees a NEW device and burns another seat.
 * It is written once and never rotated.
 *
 * Loaded as a plain script (no modules - the service worker uses importScripts
 * and the side panel uses a <script> tag), so it attaches a single global:
 * window.NSR_AUTH / self.NSR_AUTH.
 */

(function () {
  'use strict';

  // ── Endpoint base ────────────────────────────────────────────────────
  // Overridable at runtime via chrome.storage.local `lmsApiBase` so a test
  // instance can be pointed at without shipping a different build:
  //   chrome.storage.local.set({ lmsApiBase: 'https://lms-test.dhaninfo.ai/api/v1' })
  const LMS_API_BASE = 'https://lms.dhaninfo.ai/api/v1';

  const KEY_SESSION = 'lmsSession';
  const KEY_INSTALL = 'lmsInstallationId';
  const KEY_FINGERPRINT = 'lmsDeviceFingerprint';
  // Why the session ended ('expired' | 'revoked' | 'signed_out'). The worker
  // detects this but the login form lives in the side panel, so the reason
  // travels through storage rather than a message the panel may not be alive
  // to hear.
  const KEY_ENDED = 'lmsSessionEnded';

  let cachedBase = null;

  async function apiBase() {
    if (cachedBase) return cachedBase;
    const override = await get('lmsApiBase');
    cachedBase = (typeof override === 'string' && override)
      ? override.replace(/\/$/, '')
      : LMS_API_BASE;
    return cachedBase;
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.lmsApiBase) cachedBase = null;
    });
  } catch (_) { /* not available in every context */ }

  // ── Storage helpers ──────────────────────────────────────────────────

  async function get(key) {
    try {
      const res = await chrome.storage.local.get(key);
      return res ? res[key] : undefined;
    } catch (_) {
      return undefined;
    }
  }

  async function set(obj) {
    try {
      await chrome.storage.local.set(obj);
      return true;
    } catch (_) {
      return false;
    }
  }

  // ── Installation id ──────────────────────────────────────────────────

  /**
   * Stable per-install UUID, generated once. See the header note: this is the
   * identity the LMS binds a licence seat to, so it must survive browser
   * restarts, panel reloads and service-worker teardown.
   */
  async function getInstallationId() {
    let id = await get(KEY_INSTALL);
    if (!id) {
      id = crypto.randomUUID();
      await set({ [KEY_INSTALL]: id });
    }
    return id;
  }

  // ── Session ──────────────────────────────────────────────────────────

  /**
   * The stored session, or null. Shape:
   *   { access, refresh, username, plan_name, expiry, obtained_at }
   */
  async function getSession() {
    const s = await get(KEY_SESSION);
    if (!s || typeof s.access !== 'string' || !s.access) return null;
    return s;
  }

  async function isSignedIn() {
    return (await getSession()) !== null;
  }

  /** Why the session last ended, or '' if it was not an involuntary end. */
  async function getEndedReason() {
    const r = await get(KEY_ENDED);
    return typeof r === 'string' ? r : '';
  }

  async function clearSession(reason = '') {
    try {
      if (reason) await set({ [KEY_ENDED]: reason });
      await chrome.storage.local.remove(KEY_SESSION);
    } catch (_) { /* ignore */ }
  }

  // ── Sign in ──────────────────────────────────────────────────────────
  //
  // Two calls, per the AdminPortal integration guide §1-2:
  //
  //   POST /auth/login      username + password  -> access + refresh token
  //   POST /license/consume access token + device -> a licence for this install
  //
  // An earlier version of this file used the single-call POST /license/validate
  // instead. Both endpoints exist and both mint the same token, but they differ
  // in one way that decides it: /license/validate never touches the customer's
  // unassigned pool, so it fails with "No license assigned to this user" unless
  // an admin has already assigned that person a licence by hand. /license/consume
  // pulls from the pool automatically. With licences bought in blocks and handed
  // out on first use, consume is the flow that actually works.

  /**
   * Step 1: exchange credentials for tokens.
   * Returns { ok: true, tokens } or { ok: false, reason }.
   */
  async function login(username, password) {
    let res;
    try {
      res = await fetch(`${await apiBase()}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
    } catch (_) {
      return { ok: false, reason: 'Cannot reach the licence server. Check your connection and try again.' };
    }

    // /auth/login is rate-limited to 5/min. That is not a credential problem
    // and must not be reported as one.
    if (res.status === 429) {
      return { ok: false, reason: 'Too many sign-in attempts. Wait a minute and try again.' };
    }

    let body;
    try {
      body = await res.json();
    } catch (_) {
      return { ok: false, reason: 'The licence server returned an unreadable response.' };
    }

    if (!res.ok) {
      // Unlike /license/consume, this endpoint DOES use status codes: 401 for
      // bad credentials, 403 for a locked or disabled account. `detail` carries
      // the LMS's own wording, which distinguishes them.
      return { ok: false, reason: (body && body.detail) || 'Invalid username or password' };
    }

    return {
      ok: true,
      tokens: {
        access: body.access_token,
        refresh: body.refresh_token,
        role: body.role || '',
        userId: body.user_id || '',
        mustChangePassword: body.must_change_password === true,
      },
    };
  }

  /**
   * Step 2: ask the server for a licence for this installation.
   *
   * Returns { granted, license, reason }. Per the guide §3, a denial is a
   * normal HTTP 200 answer with granted:false - not an error to catch. Branch
   * on `granted`, never on res.ok.
   *
   * Idempotent by design (§4): called with the same device_fingerprint and
   * installation_id, it returns the licence this device already holds rather
   * than consuming another. That is what makes it safe on every launch.
   */
  async function consumeLicense(accessToken) {
    const env = describeEnvironment();

    let res;
    try {
      res = await fetch(`${await apiBase()}/license/consume`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          device_fingerprint: await deviceFingerprint(),
          installation_id: await getInstallationId(),
          browser: env.browser,
          browser_version: env.browser_version,
          operating_system: env.operating_system,
        }),
      });
    } catch (_) {
      return { granted: false, reason: 'Cannot reach the licence server. Check your connection and try again.' };
    }

    if (res.status === 401) return { granted: false, unauthorized: true, reason: 'Session expired' };

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { granted: false, reason: body.detail || `Licence check failed (HTTP ${res.status})` };
    }
    if (!body.granted) {
      // The LMS's own wording - "No license available. Ask your administrator
      // to assign a license..." - is written for the end user. Show it verbatim.
      return { granted: false, reason: body.reason || 'No licence available for this device' };
    }

    return {
      granted: true,
      license: {
        id: body.license_id,
        key: body.license_key,
        status: body.license_status,
        expiry: body.expiry,
      },
    };
  }

  /**
   * Both steps. Returns { ok: true, session } or { ok: false, reason }.
   *
   * A successful login with no licence available is NOT a session: the backend
   * would reject every call, so storing tokens would only produce confusing
   * 401s later. The tokens are dropped and the licence reason is surfaced.
   */
  async function signIn(username, password) {
    const auth = await login(username, password);
    if (!auth.ok) return auth;

    const lic = await consumeLicense(auth.tokens.access);
    if (!lic.granted) return { ok: false, reason: lic.reason };

    const session = {
      access: auth.tokens.access,
      refresh: auth.tokens.refresh,
      username,
      role: auth.tokens.role,
      userId: auth.tokens.userId,
      mustChangePassword: auth.tokens.mustChangePassword,
      // license_id is the UUID, license_key the human-readable
      // XXXX-XXXX-XXXX-XXXX form. POST /external/usage wants the UUID and
      // 404s on the key, so both are kept - see common/lmsUsage.js.
      license_id: lic.license.id,
      license_key: lic.license.key,
      license_status: lic.license.status,
      expiry: lic.license.expiry,
      obtained_at: new Date().toISOString(),
    };
    await set({ [KEY_SESSION]: session });
    try { await chrome.storage.local.remove(KEY_ENDED); } catch (_) { /* ignore */ }
    return { ok: true, session };
  }

  /**
   * Re-confirm this install's licence using the stored session. Called on every
   * panel open, per the guide §4 - there is no separate "check my licence"
   * endpoint, and consume is the check.
   *
   * This is what makes a revocation visible without waiting for the access
   * token to expire: the licence is gone from the pool, so consume answers
   * granted:false and the gate reopens.
   *
   * Returns { granted, reason }. Refreshes the token once if it has expired.
   */
  async function ensureLicense() {
    const session = await getSession();
    if (!session) return { granted: false, reason: 'Not signed in', notSignedIn: true };

    let lic = await consumeLicense(session.access);

    if (lic.unauthorized) {
      const refreshed = await refreshSession();
      if (!refreshed) {
        await clearSession('expired');
        return { granted: false, reason: 'Session expired', notSignedIn: true };
      }
      lic = await consumeLicense(refreshed.access);
      if (lic.unauthorized) {
        await clearSession('revoked');
        return { granted: false, reason: 'Session expired', notSignedIn: true };
      }
    }

    if (lic.granted) {
      const current = await getSession();
      if (current) {
        await set({
          [KEY_SESSION]: {
            ...current,
            // Re-consume can hand this device a DIFFERENT licence than it held
            // last launch (the old one revoked, a new one auto-assigned from
            // the pool). Usage must be billed against the licence in hand, so
            // the id is refreshed here rather than written once at sign-in.
            license_id: lic.license.id,
            license_key: lic.license.key,
            license_status: lic.license.status,
            expiry: lic.license.expiry,
          },
        });
      }
      return { granted: true };
    }

    // A licence that is gone is not a session worth keeping.
    await clearSession('revoked');
    return { granted: false, reason: lic.reason };
  }

  async function signOut() {
    await clearSession('signed_out');
  }

  // ── Refresh ──────────────────────────────────────────────────────────

  // Collapses concurrent refreshes. Without this, three parallel 401s would
  // fire three refresh calls; the LMS rotates the refresh token, so the second
  // and third would present an already-superseded one and sign the user out.
  let refreshInFlight = null;

  async function refreshSession() {
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = (async () => {
      const session = await getSession();
      if (!session || !session.refresh) return null;

      let res;
      try {
        res = await fetch(`${await apiBase()}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: session.refresh }),
        });
      } catch (_) {
        // Network failure is not proof the session is dead - keep it and let
        // the next call retry rather than signing someone out over one blip.
        return null;
      }

      if (!res.ok) {
        // The LMS rejected the refresh token outright: the licence was revoked,
        // the account disabled, or the token family rotated out from under us.
        // This one IS terminal.
        await clearSession('revoked');
        return null;
      }

      const body = await res.json().catch(() => ({}));
      if (!body.access_token) {
        await clearSession('revoked');
        return null;
      }

      const next = {
        ...session,
        access: body.access_token,
        refresh: body.refresh_token || session.refresh,
        obtained_at: new Date().toISOString(),
      };
      await set({ [KEY_SESSION]: next });
      return next;
    })();

    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  // ── Authorised fetch ─────────────────────────────────────────────────

  /**
   * Headers to attach to a backend call, or null when not signed in.
   * Callers that can tolerate an unauthenticated call (usage tracking) should
   * treat null as "send what you can"; callers that cannot (the AI endpoints)
   * should refuse to fire.
   */
  async function authHeaders(extra = {}) {
    const session = await getSession();
    if (!session) return null;
    return { ...extra, Authorization: `Bearer ${session.access}` };
  }

  /**
   * fetch() with the access token attached, refreshing once on a 401 and
   * replaying the request. Use this for every call to a protected endpoint.
   *
   * Throws NotSignedInError when there is no session at all, so a caller can
   * tell "you are signed out" apart from "the server said no".
   */
  async function authedFetch(url, options = {}) {
    const session = await getSession();
    if (!session) throw new NotSignedInError();

    const withAuth = (token) => ({
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
    });

    let res = await fetch(url, withAuth(session.access));
    if (res.status !== 401) return res;

    // One retry, and only one. If the refreshed token is also rejected the
    // problem is not staleness and replaying again would just loop.
    const refreshed = await refreshSession();
    if (!refreshed) {
      await clearSession('expired');
      throw new NotSignedInError();
    }
    res = await fetch(url, withAuth(refreshed.access));
    if (res.status === 401) {
      await clearSession('revoked');
      throw new NotSignedInError();
    }
    return res;
  }

  class NotSignedInError extends Error {
    constructor() {
      super('Not signed in');
      this.name = 'NotSignedInError';
      this.notSignedIn = true;
    }
  }

  // ── Environment ──────────────────────────────────────────────────────

  /**
   * Browser/OS labels in the shape the LMS's RegisterDeviceRequest expects.
   *
   * Sourced from navigator.userAgentData rather than the User-Agent string,
   * per the guide's field notes ("as reported by the extension's own runtime,
   * not the User-Agent string"). The UA string is frozen and progressively
   * reduced in modern Chrome, so its version is already becoming a lie; the
   * UA-CH brands list is the value Chrome actually maintains.
   *
   * Falls back to UA parsing where userAgentData is unavailable (older Chrome,
   * non-Chromium). Deliberately coarse either way - this describes a device,
   * it does not fingerprint it.
   */
  function describeEnvironment() {
    const uaData = (typeof navigator !== 'undefined') ? navigator.userAgentData : null;

    if (uaData && Array.isArray(uaData.brands)) {
      // brands also contains a deliberately meaningless entry ("Not;A=Brand")
      // to catch brand-sniffing bugs, so match the real ones by name.
      const pick = (name) => uaData.brands.find((b) => b.brand === name);
      const brand = pick('Microsoft Edge') || pick('Google Chrome') || pick('Chromium');
      if (brand) {
        return {
          browser: brand.brand === 'Microsoft Edge' ? 'Edge' : 'Chrome',
          browser_version: String(brand.version || ''),
          operating_system: uaData.platform || 'Unknown',
        };
      }
    }

    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    let browser = 'Chrome';
    let browser_version = '';
    const edge = ua.match(/Edg\/([\d.]+)/);
    const chromeVer = ua.match(/Chrome\/([\d.]+)/);
    if (edge) {
      browser = 'Edge';
      browser_version = edge[1];
    } else if (chromeVer) {
      browser_version = chromeVer[1];
    }

    let operating_system = 'Unknown';
    if (/Windows/i.test(ua)) operating_system = 'Windows';
    else if (/Macintosh|Mac OS/i.test(ua)) operating_system = 'macOS';
    else if (/Linux/i.test(ua)) operating_system = 'Linux';

    return { browser, browser_version, operating_system };
  }

  /**
   * Stable per-browser-profile UUID identifying this machine.
   *
   * The guide (§2 field notes) asks for "same machine, same fingerprint, every
   * launch" and the LMS hashes whatever it receives, so a stored random UUID
   * satisfies it exactly - and unlike a derived hash it cannot drift when
   * Chrome changes what it reports about itself.
   *
   * Kept separate from the installation id even though both are UUIDs stored
   * side by side: the guide distinguishes the machine from the install, and
   * collapsing them would make a reinstall look like a new device and consume
   * a second seat.
   */
  async function deviceFingerprint() {
    let fp = await get(KEY_FINGERPRINT);
    if (!fp) {
      fp = crypto.randomUUID();
      await set({ [KEY_FINGERPRINT]: fp });
    }
    return fp;
  }

  const api = {
    LMS_API_BASE,
    apiBase,
    getInstallationId,
    deviceFingerprint,
    getSession,
    isSignedIn,
    getEndedReason,
    login,
    consumeLicense,
    signIn,
    ensureLicense,
    signOut,
    clearSession,
    refreshSession,
    authHeaders,
    authedFetch,
    NotSignedInError,
    describeEnvironment,
  };

  if (typeof window !== 'undefined') window.NSR_AUTH = api;
  else self.NSR_AUTH = api;
})();
