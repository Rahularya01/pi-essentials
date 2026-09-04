import type { Usage } from "@earendil-works/pi-ai";

export class PiEssentialsError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code = "PI_ESSENTIALS_ERROR", retryable = false) {
    super(message);
    this.name = "PiEssentialsError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Abort/timeout detection. Deliberately narrow: a remote "504 Gateway Timeout"
 * body must not look like a local cancellation, or callers skip their fallbacks.
 */
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name?: unknown }).name) : "";
  if (name === "AbortError" || name === "TimeoutError") return true;
  if ((error as { code?: unknown }).code === "ABORT_ERR") return true;
  const message = errorMessage(error).toLowerCase();
  if (/^http \d{3}\b/.test(message)) return false;
  return (
    message.includes("the operation was aborted") ||
    message.includes("was cancelled or timed out") ||
    message.includes("this operation was aborted") ||
    message.includes("request aborted")
  );
}

export function toolText(text: string, details: object = {}, usage?: Usage) {
  return {
    content: [{ type: "text" as const, text }],
    details,
    ...(usage ? { usage } : {}),
  };
}

/**
 * Fail a tool call.
 *
 * Pi only marks a tool result `isError: true` when `execute` throws, so every
 * genuine failure — bad arguments included — must raise rather than return
 * prose that merely starts with "Error:".
 */
export function toolFailure(message: string, code = "PI_ESSENTIALS_ERROR"): never {
  throw new PiEssentialsError(message, code);
}

/** Truncate to a UTF-8 byte budget without splitting a multi-byte character. */
export function capBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const limit = Math.max(16, Math.floor(maxBytes));
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= limit) return { text, truncated: false };

  // Reserve room for the marker itself, then walk back off any continuation
  // byte (0b10xxxxxx) so the cut lands on a character boundary.
  let end = limit;
  let marker = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    marker = `\n\n[Truncated: ${buffer.byteLength - end} of ${buffer.byteLength} bytes omitted.]`;
    let next = Math.max(0, limit - Buffer.byteLength(marker, "utf8"));
    while (next > 0 && (buffer[next] & 0xc0) === 0x80) next -= 1;
    if (next === end) break;
    end = next;
  }
  marker = `\n\n[Truncated: ${buffer.byteLength - end} of ${buffer.byteLength} bytes omitted.]`;
  if (Buffer.byteLength(marker, "utf8") > limit) {
    marker = "\n\n[Truncated]".slice(0, limit);
    end = 0;
  }
  return { text: `${buffer.subarray(0, end).toString("utf8")}${marker}`, truncated: true };
}

export function capText(text: string, maxChars: number): { text: string; truncated: boolean } {
  const limit = Math.max(1, Math.floor(maxChars));
  if (text.length <= limit) return { text, truncated: false };
  const omitted = text.length - limit;
  return {
    text: `${text.slice(0, limit)}\n\n[Truncated: ${omitted} characters omitted. Request another slice if you need more.]`,
    truncated: true,
  };
}
