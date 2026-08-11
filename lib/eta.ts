/**
 * Time-remaining model for a stitching job.
 *
 * The naive version — `elapsed / progress` — assumes progress advances at a
 * constant rate. It does not: extraction and upload race through the early part
 * of the bar and the server's overlap search crawls through the rest. So the
 * first estimate came out far too low and then climbed as reality asserted
 * itself, which reads as the app not knowing what it is doing.
 *
 * Three things fix that:
 *
 *   1. Start from a deliberately pessimistic guess derived from the frame
 *      count, so the first figure shown is considered rather than extrapolated
 *      from two seconds of the fastest stage.
 *   2. Blend that prior into the measured rate, weighted by how much evidence
 *      there is, and pad the measurement while confidence is low — the estimate
 *      approaches the truth from above.
 *   3. Never let the displayed figure increase. It may fall as fast as reality
 *      allows, but it only ever counts down.
 *
 * The functions here are pure so the behaviour can be tested against a replayed
 * progress trace instead of being judged by watching a spinner.
 */

/** Expected milliseconds per extracted frame before anything is measured. */
export const ETA_PRIOR_MS_PER_FRAME = 420;
/** Below this floor a job is too short for an estimate to be worth showing. */
export const ETA_MIN_TOTAL_MS = 8000;
/** Progress at which the measured rate is trusted completely. */
export const ETA_TRUST_AT = 0.5;
/** Extra padding on a measured estimate while confidence is still low. */
export const ETA_EARLY_PAD = 0.5;
/** How fast a revised total may pull the estimate down (per revision). */
export const ETA_MAX_SHRINK = 0.85;

/** The up-front estimate, before any progress has been observed. */
export function initialTotalMs(estimatedFrames: number): number {
  return Math.max(ETA_MIN_TOTAL_MS, estimatedFrames * ETA_PRIOR_MS_PER_FRAME);
}

/**
 * Revise the estimated total duration given what has happened so far.
 *
 * `prior` keeps its influence while progress is small, which is exactly when
 * `elapsed / progress` is least trustworthy.
 */
export function reviseTotalMs(
  previousTotal: number,
  elapsedMs: number,
  progress: number,
  prior: number
): number {
  if (!(progress > 0) || elapsedMs <= 0) return previousTotal;
  const measured = elapsedMs / progress;
  const confidence = Math.min(1, Math.max(0, progress / ETA_TRUST_AT));
  const padded = measured * (1 + (1 - confidence) * ETA_EARLY_PAD);
  const blended = confidence * padded + (1 - confidence) * prior;
  // Let it fall, but not instantly — a single fast stage should not convince
  // the estimate that the whole job is nearly over.
  return Math.max(previousTotal * ETA_MAX_SHRINK, blended);
}

/**
 * While no new progress has arrived, the countdown drains at this fraction of
 * real time. It has to keep moving — a frozen number looks like a hung app —
 * but draining at full speed through a long quiet stage spends the whole budget
 * and parks on "Finishing up..." far too early.
 */
export const ETA_STALE_DECAY = 0.45;

/**
 * The figure to display, given the previous one.
 *
 * `null` for `previousShown` means nothing has been shown yet. `maxDropMs` caps
 * how much the figure may fall on its own this tick — full wall time when
 * progress just advanced, less when the job has gone quiet.
 */
export function nextShownMs(
  previousShown: number | null,
  remainingMs: number,
  maxDropMs: number
): number {
  if (previousShown === null) return Math.max(0, remainingMs);
  const ceiling = Math.max(0, previousShown - maxDropMs);
  return Math.max(0, Math.min(remainingMs, ceiling));
}

/** How far the countdown may fall this tick. */
export function allowedDropMs(tickMs: number, progressAdvanced: boolean): number {
  return progressAdvanced ? tickMs : tickMs * ETA_STALE_DECAY;
}

/** Round up to a coarse step so the countdown does not jitter digit by digit. */
export function formatEta(ms: number): string {
  const sec = Math.ceil(ms / 1000);
  if (sec < 60) return `~${Math.max(5, Math.ceil(sec / 5) * 5)}s remaining`;
  const rounded = Math.ceil(sec / 10) * 10;
  const min = Math.floor(rounded / 60);
  const rem = rounded % 60;
  return rem === 0 ? `~${min}m remaining` : `~${min}m ${rem}s remaining`;
}
