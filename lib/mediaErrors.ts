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
    // Deliberately not "this is in iCloud". That was the first guess and it was
    // wrong: the message shipped, and it appeared for a recording sitting on
    // the device that played instantly in Photos. State what is known — the
    // photo library would not hand the file over — and offer iCloud as one
    // possibility rather than a diagnosis.
    return (
      "This recording could not be read from your photo library. Try selecting " +
      "it again, or a different one. If it is stored in iCloud, opening it once " +
      "in Photos may help."
    );
  }

  return raw.trim() || "Failed to process video";
}

/**
 * A short technical tag for the error screen's code line.
 *
 * The friendly message deliberately drops Apple's domain and number, and that
 * turned out to cost more than it saved: the one screenshot that could have
 * identified the failure no longer carried the one detail that identifies it.
 * Keep the sentence readable and put the identifier on its own small line, the
 * way a support code is meant to work.
 */
export function technicalErrorCode(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "";

  // "…(PHPhotosErrorDomain error 3164.)" -> "PHPhotos-3164"
  const domain = raw.match(/([A-Za-z]+)ErrorDomain\s+error\s+(-?\d+)/i);
  if (domain) return `${domain[1]}-${domain[2]}`;

  // Node and RN style: err.code is already the identifier.
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.trim()) return code.trim();

  return "";
}
