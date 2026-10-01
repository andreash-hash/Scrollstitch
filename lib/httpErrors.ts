/**
 * Turning a failed HTTP response into something a person can read.
 *
 * The server answers errors as JSON — `{ "error": "Not enough distinct frames" }`
 * — and the upload code used to throw `await res.text()` straight onto the
 * error screen, so people saw `{"error":"..."}` with the braces and quotes. A
 * proxy or load balancer in front of the server answers with an HTML page
 * instead, which was worse. Pull the server's own sentence out when there is
 * one, and otherwise say what the status means in plain words.
 */

export class HttpError extends Error {
  readonly status: number;
  /** Shown on the error screen's code line, e.g. "HTTP-413". */
  readonly code: string;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = `HTTP-${status}`;
  }
}

const MAX_PLAIN_TEXT = 200;

export function httpErrorMessage(status: number, body: string | null | undefined): string {
  const text = (body ?? "").trim();

  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
      const said = parsed.error ?? parsed.message;
      if (typeof said === "string" && said.trim()) return said.trim();
    } catch {
      // Not JSON after all — fall through to the other cases.
    }
  }

  // A short plain-text reason is already a sentence; HTML never is.
  if (text && !text.startsWith("{") && !/<[a-z!/]/i.test(text) && text.length <= MAX_PLAIN_TEXT) {
    return text;
  }

  if (status === 413) return "This recording is too large to upload. Try a shorter one.";
  if (status === 429) return "The server is busy right now. Please try again in a minute.";
  if (status >= 500) return "The server ran into a problem. Please try again.";
  return `The server could not accept the upload (HTTP ${status}).`;
}

/**
 * Whether sending the same request again could succeed. A 400 will be a 400
 * the second and third time too, and three of them only make a person wait
 * longer for the same message.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
