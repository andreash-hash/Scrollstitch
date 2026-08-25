/**
 * Turn a processing failure into something worth sending to a phone.
 *
 * The push that prompted this read:
 *
 *   Stitching failed: Input file is missing:
 *   /tmp/scrollstitch-sessions/mt8xbwlmss701niv/00000_00025
 *
 * That is Sharp reporting a path, on a lock screen, to someone who never chose
 * a path and cannot act on one. The frame number and session id are ours, not
 * theirs. Keep the detail in the server log where it is useful and say what
 * happened in terms of the thing they did.
 */
export function readableProcessingError(err: unknown): string {
  // Deliberately not String(err): an object with no message stringifies to
  // "[object Object]", which is worse than saying nothing and letting the
  // fallback speak.
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "";

  // Sharp, when a path it was handed no longer exists.
  if (/input file is missing/i.test(raw)) {
    return "Some of the uploaded frames were no longer available. Please try again.";
  }

  // Sharp, when a file exists but holds nothing it can decode.
  if (/unsupported image format|input buffer contains unsupported image format/i.test(raw)) {
    return "One of the uploaded frames could not be read. Please try again.";
  }

  if (/ENOSPC|no space left/i.test(raw)) {
    return "The server ran out of space while stitching. Please try again shortly.";
  }

  return raw.trim() || "Processing failed unexpectedly.";
}
