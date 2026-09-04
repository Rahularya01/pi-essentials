import http from "node:http";
import https from "node:https";
import type { LookupAddress } from "node:dns";
import type { Readable } from "node:stream";
import zlib from "node:zlib";
import { timeoutSignal } from "../security/env.ts";
import { redirectUrl, resolveSafeUrl, SsrfError, type PinnedAddress, type SsrfPolicy } from "../security/ssrf.ts";

const MAX_REDIRECTS = 5;
const USER_AGENT = "pi-essentials/0.1 (+https://github.com/rahularya/pi-essentials)";

/** Statuses after which a POST must be replayed as a GET. */
const SEE_OTHER = new Set([301, 302, 303]);

/** Compressed bytes we are willing to read for a given decompressed budget. */
const COMPRESSION_RATIO_GUARD = 20;

export interface SafeFetchOptions {
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  body?: string;
  /** Hosts the user has explicitly allowed even though they are private. */
  allowedHosts?: ReadonlySet<string>;
}

export interface SafeFetchResult {
  url: string;
  status: number;
  contentType: string;
  charset: string;
  body: Uint8Array;
  truncated: boolean;
  text(): string;
}

export function charsetFromContentType(contentType: string): string {
  const match = /charset\s*=\s*"?([\w.:+-]+)"?/i.exec(contentType);
  return match ? match[1].toLowerCase() : "utf-8";
}

/** Decode bytes with the declared charset, falling back to UTF-8 for unknown labels. */
export function decodeBody(body: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(body);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(body);
  }
}

/**
 * A DNS resolver that only ever answers with addresses this request already
 * validated. Node re-resolves the hostname when it connects, which would
 * otherwise let a hostile server return a public IP to the safety check and a
 * private one to the socket (DNS rebinding).
 */
export function pinnedLookup(addresses: PinnedAddress[]): NonNullable<http.RequestOptions["lookup"]> {
  return ((
    _hostname: string,
    options: { all?: boolean },
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ) => {
    if (addresses.length === 0) {
      callback(Object.assign(new Error("No validated addresses for host"), { code: "ENOTFOUND" }), "", 0);
      return;
    }
    if (options?.all) {
      callback(null, addresses.map((entry) => ({ address: entry.address, family: entry.family })));
      return;
    }
    callback(null, addresses[0].address, addresses[0].family);
  }) as NonNullable<http.RequestOptions["lookup"]>;
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  stream: http.IncomingMessage;
}

function sendRequest(
  url: URL,
  addresses: PinnedAddress[],
  options: SafeFetchOptions,
  method: string,
  body: string | undefined,
  signal: AbortSignal,
): Promise<RawResponse> {
  const transport = url.protocol === "https:" ? https : http;
  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
    "accept-encoding": "gzip, br",
    ...options.headers,
  };
  if (body !== undefined) {
    headers["content-length"] = String(Buffer.byteLength(body, "utf8"));
    headers["content-type"] ??= "application/x-www-form-urlencoded";
  }

  return new Promise<RawResponse>((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method,
        headers,
        // TLS still verifies the certificate against the real hostname: `servername`
        // defaults to the URL host, and only address resolution is pinned.
        lookup: pinnedLookup(addresses),
        signal,
      },
      (response) => resolve({ status: response.statusCode ?? 0, headers: response.headers, stream: response }),
    );
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function decompress(response: http.IncomingMessage): Readable {
  const encoding = String(response.headers["content-encoding"] ?? "").trim().toLowerCase();
  if (!encoding || encoding === "identity") return response;
  if (encoding === "gzip" || encoding === "x-gzip") return response.pipe(zlib.createGunzip());
  if (encoding === "br") return response.pipe(zlib.createBrotliDecompress());
  if (encoding === "deflate") return response.pipe(zlib.createUnzip());
  // We only advertise gzip and br, so anything else is the server misbehaving.
  response.destroy();
  throw new Error(`Unsupported content-encoding "${encoding}"`);
}

async function readLimited(
  response: http.IncomingMessage,
  maxBytes: number,
): Promise<{ body: Uint8Array; truncated: boolean }> {
  const stream = decompress(response);
  const chunks: Buffer[] = [];
  let kept = 0;
  let truncated = false;

  if (stream !== response) {
    // Only meaningful while decompressing: cap the compressed input so a
    // decompression bomb cannot expand into unbounded memory. When the body is
    // identity-encoded the decompressed cap below already bounds the read, and
    // attaching a "data" listener there would race the async iteration.
    const compressedCap = maxBytes * COMPRESSION_RATIO_GUARD;
    let rawSeen = 0;
    response.on("data", (chunk: Buffer) => {
      rawSeen += chunk.byteLength;
      if (rawSeen > compressedCap) {
        truncated = true;
        response.destroy();
      }
    });
  }

  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const room = maxBytes - kept;
      if (room === 0) {
        truncated = true;
        break;
      }
      if (chunk.byteLength > room) {
        chunks.push(chunk.subarray(0, room));
        kept += room;
        truncated = true;
        break;
      }
      chunks.push(chunk);
      kept += chunk.byteLength;
    }
  } catch (error) {
    // A destroyed stream is how we stop early; only surface real read failures.
    if (!truncated) throw error;
  } finally {
    response.destroy();
  }

  return { body: new Uint8Array(Buffer.concat(chunks, kept)), truncated };
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
  const policy: SsrfPolicy = { allowedHosts: options.allowedHosts };
  let target = await resolveSafeUrl(rawUrl, policy);
  const signal = timeoutSignal(options.timeoutMs, options.signal);
  let method: string = options.method ?? "GET";
  let body = options.body;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await sendRequest(target.url, target.addresses, options, method, body, signal);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      response.stream.resume();
      response.stream.destroy();
      if (!location) throw new Error(`Redirect from ${target.url.href} was missing a Location header.`);
      // Every hop is validated and pinned again; a redirect cannot smuggle us
      // onto a private address.
      target = await resolveSafeUrl(redirectUrl(target.url, location).href, policy);
      if (method === "POST" && SEE_OTHER.has(response.status)) {
        method = "GET";
        body = undefined;
      }
      continue;
    }

    const contentType = String(response.headers["content-type"] ?? "");
    const charset = charsetFromContentType(contentType);

    if (response.status < 200 || response.status >= 300) {
      const snippet = await readLimited(response.stream, Math.min(options.maxBytes, 2048)).catch(() => ({
        body: new Uint8Array(),
        truncated: false,
      }));
      const preview = decodeBody(snippet.body, charset).replace(/\s+/g, " ").trim().slice(0, 400);
      throw new Error(`HTTP ${response.status} fetching ${target.url.href}${preview ? `: ${preview}` : ""}`);
    }

    const read = await readLimited(response.stream, options.maxBytes);
    return {
      url: target.url.href,
      status: response.status,
      contentType,
      charset,
      body: read.body,
      truncated: read.truncated,
      text: () => decodeBody(read.body, charset),
    };
  }

  throw new SsrfError(`Too many redirects fetching ${rawUrl}`, "invalid-url");
}
