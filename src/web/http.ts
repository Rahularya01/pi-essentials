import { timeoutSignal } from "../security/env.ts";
import { assertSafeUrl, redirectUrl, SsrfError } from "../security/ssrf.ts";

const MAX_REDIRECTS = 5;
const USER_AGENT = "pi-essentials/0.1 (+https://github.com/rahularya/pi-essentials)";

export interface SafeFetchOptions {
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  body?: string;
}

export interface SafeFetchResult {
  url: string;
  status: number;
  contentType: string;
  body: Uint8Array;
  text(): string;
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
  let current = await assertSafeUrl(rawUrl);
  const signal = timeoutSignal(options.timeoutMs, options.signal);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(current, {
      method: options.method ?? "GET",
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
        ...options.headers,
      },
      body: options.body,
      redirect: "manual",
      signal,
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect from ${current.href} was missing a Location header.`);
      current = await assertSafeUrl(redirectUrl(current, location).href);
      continue;
    }

    if (!response.ok) {
      const snippet = await readLimited(response, Math.min(options.maxBytes, 2048), signal);
      const preview = new TextDecoder("utf-8", { fatal: false }).decode(snippet).slice(0, 400);
      throw new Error(`HTTP ${response.status} fetching ${current.href}${preview ? `: ${preview}` : ""}`);
    }

    const body = await readLimited(response, options.maxBytes, signal);
    const contentType = response.headers.get("content-type") ?? "";
    return {
      url: current.href,
      status: response.status,
      contentType,
      body,
      text: () => new TextDecoder("utf-8", { fatal: false }).decode(body),
    };
  }

  throw new SsrfError(`Too many redirects fetching ${rawUrl}`, "invalid-url");
}

async function readLimited(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    return buf.byteLength > maxBytes ? buf.slice(0, maxBytes) : buf;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    if (signal.aborted) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Fetch was cancelled or timed out.");
    }
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      chunks.push(value.slice(0, Math.max(0, maxBytes - (total - value.byteLength))));
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
