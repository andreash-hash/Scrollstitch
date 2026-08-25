/**
 * Turn whatever the media stack threw into something a person can act on.
 *
 * PhotoKit reports its failures as "The operation couldn't be completed.
 * (PHPhotosErrorDomain error 3164.)" — accurate, addressed to a developer, and
 * useless on the screen of someone who has just paid and wants to know whether
 * to try again or give up.
 *
 * The error domain is the only reliable part of that string: the numeric code
 * varies and Apple does not document most of them. So match the domain and say
 * what it means in practice on a real phone — the recording is in iCloud and
 * could not be pulled down.
 */
export function readableMediaError(err: unknown): string {
  // Deliberately not String(err): an object with no message stringifies to
  // "[object Object]", which is worse on screen than saying nothing and letting
  // the fallback speak.
  const raw =
    typeof err === "string"
      ? err
      : typeof err === "object" && err !== null && "message" in err
        ? String((err as { message?: unknown }).message ?? "")
        : "";

  if (/PHPhotosErrorDomain/i.test(raw)) {
    return (
      "That recording could not be opened. It may still be in iCloud rather " +
      "than on this device — open it in Photos once to download it, then try again."
    );
  }

  return raw.trim() || "Failed to process video";
}
