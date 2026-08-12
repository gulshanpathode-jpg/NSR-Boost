/**
 * common/feedback.js — ground truth for feedback, and the auto-send safety net.
 *
 * Two problems this solves:
 *
 * 1. **The payload only learned from clicks.** `answerSelected` is derived from
 *    Accept/Reject decisions. If an inspector ignores the panel and simply
 *    types the right answer into the form, the old payload learned nothing.
 *    So at send time we RE-SCRAPE the live form and record what it actually
 *    says — `finalFormAnswer` — plus an objectively computed `aiMatchedFinal`.
 *    No user opinion involved.
 *
 * 2. **Feedback was lost when people forgot to click Send.** A draft payload is
 *    kept in chrome.storage.local and flushed by the service worker's alarm,
 *    so closing the panel or hitting Refresh no longer discards the review.
 *
 * Loaded by BOTH the side panel (manual send) and the service worker (auto
 * send), so the enrichment logic is identical either way. Attaches
 * window.NSR_FEEDBACK / self.NSR_FEEDBACK.
 *
 * Honest limits, documented because they affect how the numbers should be read:
 *   - `finalFormAnswer` is the inspector's FINAL answer, not verified truth.
 *     It is a much better proxy than a click, but it is still not ground truth
 *     in the strict sense.
 *   - Re-scraping needs the LC360 tab still on that form. If it moved on, the
 *     payload carries ground_truth: 'unavailable' rather than a guess.
 */

(function () {
  'use strict';

  const KEY_DRAFT = 'feedbackDraft';

  // ── Answer comparison ────────────────────────────────────────────────

  /**
   * Normalise one answer for comparison only (never for storage).
   *
   * Text fields are the weak spot in the existing accuracy metrics — trailing
   * whitespace, double spaces and casing differences would otherwise read as
   * genuine disagreement and understate agreement badly.
   */
  function normalizeAnswer(v) {
    if (v == null) return '';
    if (Array.isArray(v)) {
      return v
        .map((x) => normalizeAnswer(x))
        .filter((s) => s !== '')
        .sort()
        .join('');
    }
    return String(v)
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /**
   * True when two answers mean the same thing. Multi-select is compared as a
   * SET (order-insensitive), matching how the dashboard compares jsonb arrays.
   *
   * Returns null when either side is empty — "no answer" is not agreement and
   * must not be counted as either a match or a mismatch.
   */
  function answersEquivalent(a, b) {
    const na = normalizeAnswer(a);
    const nb = normalizeAnswer(b);
    if (na === '' || nb === '') return null;
    return na === nb;
  }

  // ── Enrichment ───────────────────────────────────────────────────────

  /**
   * Build questionId → current answer from a fresh SCRAPE result.
   * `items` is the extractor's output: { questionId, inputType, answer, ... }
   */
  function indexScrapedAnswers(items) {
    const map = new Map();
    (items || []).forEach((it) => {
      if (it && it.type === 'question' && it.questionId) {
        map.set(String(it.questionId), it);
      }
    });
    return map;
  }

  /**
   * Fold live form values into a feedback payload.
   *
   * Existing fields are left completely untouched — currentAnswer, formAnswer,
   * imageAnswer and answerSelected keep their meaning, so the 159 feedback rows
   * already in verify_results stay comparable. Everything here is additive.
   *
   * Per question, adds:
   *   finalFormAnswer  what the form says right now (post manual edits)
   *   aiMatchedFinal   true/false/null - AI answer vs finalFormAnswer
   *   changedSinceSync true when the inspector altered the field after Sync
   *   groundTruth      'ok' | 'question_missing'
   *
   * @param payload  the payload from buildFeedbackPayload()
   * @param items    fresh scrape items, or null when re-scrape failed
   */
  function enrichWithGroundTruth(payload, items) {
    const out = { ...payload, feedback: (payload.feedback || []).slice() };

    if (!items) {
      out.ground_truth = 'unavailable';
      out.feedback = out.feedback.map((f) => ({
        ...f,
        finalFormAnswer: null,
        aiMatchedFinal: null,
        changedSinceSync: null,
        groundTruth: 'unavailable',
      }));
      return out;
    }

    const scraped = indexScrapedAnswers(items);
    let matched = 0;
    let compared = 0;
    let missing = 0;

    out.feedback = out.feedback.map((f) => {
      const hit = scraped.get(String(f.questionId));
      if (!hit) {
        missing++;
        return {
          ...f,
          finalFormAnswer: null,
          aiMatchedFinal: null,
          changedSinceSync: null,
          groundTruth: 'question_missing',
        };
      }

      const isCheckbox = (hit.inputType || f.questionType) === 'checkbox';
      const raw = hit.answer;
      const finalFormAnswer = raw == null
        ? (isCheckbox ? [] : '')
        : (isCheckbox
          ? (Array.isArray(raw) ? raw.map((s) => String(s).trim()).filter(Boolean)
            : (String(raw).trim() ? [String(raw).trim()] : []))
          : String(raw).trim());

      // Compare against the same signal the dashboard's answer-agreement
      // metric uses (image pass), falling back to the form pass when the
      // image pass is absent.
      const aiAnswer =
        (Array.isArray(f.imageAnswer) ? f.imageAnswer.length : f.imageAnswer)
          ? f.imageAnswer
          : f.formAnswer;

      const aiMatchedFinal = answersEquivalent(aiAnswer, finalFormAnswer);
      if (aiMatchedFinal !== null) {
        compared++;
        if (aiMatchedFinal) matched++;
      }

      return {
        ...f,
        finalFormAnswer,
        aiMatchedFinal,
        changedSinceSync: answersEquivalent(f.currentAnswer, finalFormAnswer) === false,
        groundTruth: 'ok',
      };
    });

    out.ground_truth = 'ok';
    out.ground_truth_stats = {
      compared,
      matched,
      missing,
      // Deliberately null rather than 0 when nothing was comparable, so a run
      // with no usable answers can't be read as 0% agreement.
      agreement: compared ? Math.round((matched / compared) * 1000) / 1000 : null,
    };
    return out;
  }

  /**
   * Stamp how this submission was triggered and how much of it a human
   * actually reviewed.
   *
   * Auto-sent payloads carry every question, reviewed or not (that is the
   * chosen policy) — these counters are what let the backend still tell a
   * fully-reviewed submission from an untouched one.
   */
  function stampProvenance(payload, { trigger, reviewedCount, totalCount }) {
    return {
      ...payload,
      trigger: trigger || 'manual',
      reviewed_count: reviewedCount,
      total_count: totalCount,
    };
  }

  // ── Draft persistence (the safety net) ───────────────────────────────

  /**
   * Save the in-progress review so it survives the panel closing.
   *
   * `tabId` and `pageKey` are recorded so the service worker can re-scrape the
   * RIGHT tab at flush time, and skip enrichment if that tab has moved to a
   * different page.
   */
  async function saveDraft(draft) {
    try {
      await chrome.storage.local.set({
        [KEY_DRAFT]: { ...draft, saved_at: new Date().toISOString() },
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  async function getDraft() {
    try {
      const res = await chrome.storage.local.get(KEY_DRAFT);
      return (res && res[KEY_DRAFT]) || null;
    } catch (_) {
      return null;
    }
  }

  async function clearDraft() {
    try {
      await chrome.storage.local.remove(KEY_DRAFT);
    } catch (_) { /* ignore */ }
  }

  const api = {
    KEY_DRAFT,
    normalizeAnswer,
    answersEquivalent,
    indexScrapedAnswers,
    enrichWithGroundTruth,
    stampProvenance,
    saveDraft,
    getDraft,
    clearDraft,
  };

  if (typeof window !== 'undefined') window.NSR_FEEDBACK = api;
  else self.NSR_FEEDBACK = api;
})();
