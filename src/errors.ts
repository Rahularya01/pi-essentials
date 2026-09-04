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

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name?: unknown }).name) : "";
  const message = errorMessage(error).toLowerCase();
  return name === "AbortError" || name === "TimeoutError" || message.includes("aborted") || message.includes("timed out");
}

export function toolText(text: string, details: object = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

export function toolError(message: string, details: object = {}) {
  return toolText(`Error: ${message}`, { ...details, error: message });
}

export function capText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const omitted = text.length - maxChars;
  return {
    text: `${text.slice(0, maxChars)}\n\n[Truncated: ${omitted} characters omitted. Request another slice if you need more.]`,
    truncated: true,
  };
}
