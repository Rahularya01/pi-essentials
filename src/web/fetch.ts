import type { ResolvedWebConfig } from "../config.ts";
import { capText, errorMessage, isAbortError, PiEssentialsError } from "../errors.ts";
import { SsrfError } from "../security/ssrf.ts";
import { getCache, putCache, sliceMarkdown } from "./cache.ts";
import { extractReadable } from "./extract.ts";
import { safeFetch } from "./http.ts";

export interface FetchPageResult {
  url: string;
  title: string;
  markdown: string;
  truncated: boolean;
  cacheId: string;
  totalChars: number;
  /** Character offset the returned slice starts at. */
  offset: number;
}

/** Content types that carry no readable text. */
const BINARY_TYPE = /^(?:image|audio|video|font)\/|^application\/(?:pdf|zip|gzip|octet-stream|x-|vnd\.(?!.*\+(?:json|xml)))/i;

/** Content types that are already plain text and must not go through Readability. */
const PLAIN_TYPE = /(?:^text\/(?:plain|markdown|csv|x-markdown)|json|yaml|javascript|typescript|\+xml$|^text\/xml)/i;

export async function fetchPage(
  rawUrl: string,
  config: ResolvedWebConfig["fetch"],
  signal?: AbortSignal,
  slice?: { offset?: number; limit?: number },
  allowedHosts?: ReadonlySet<string>,
): Promise<FetchPageResult> {
  try {
    const response = await safeFetch(rawUrl, {
      timeoutMs: config.timeoutMs,
      maxBytes: config.maxBytes,
      signal,
      allowedHosts,
    });
    const contentType = response.contentType.toLowerCase();
    if (BINARY_TYPE.test(contentType)) {
      throw new PiEssentialsError(
        `${response.url} returned binary content (${contentType || "unknown type"}); web_fetch only reads text pages.`,
        "WEB_FETCH_BINARY",
      );
    }

    let markdown: string;
    let title = response.url;
    if (PLAIN_TYPE.test(contentType)) {
      markdown = response.text();
    } else {
      const extracted = extractReadable(response.text(), response.url);
      markdown = extracted.markdown;
      title = extracted.title;
      if (extracted.byline) markdown = `${extracted.byline}\n\n${markdown}`;
    }
    if (response.truncated) {
      markdown += `\n\n[Download stopped at ${config.maxBytes} bytes; the page may continue past this point.]`;
    }
    if (!markdown.trim()) {
      markdown = "(The page returned no readable text. It may require JavaScript.)";
    }
    return finish(response.url, title, markdown, config, slice);
  } catch (error) {
    if (isAbortError(error)) {
      throw new PiEssentialsError(`Fetching ${rawUrl} was cancelled or timed out.`, "WEB_FETCH_TIMEOUT", true);
    }
    if (error instanceof SsrfError) throw error;
    if (error instanceof PiEssentialsError && error.code === "WEB_FETCH_BINARY") throw error;
    if (config.jinaFallback) {
      try {
        return await fetchViaJina(rawUrl, config, signal, slice, allowedHosts);
      } catch (fallbackError) {
        if (signal?.aborted || isAbortError(fallbackError)) {
          throw new PiEssentialsError(`Fetching ${rawUrl} was cancelled or timed out.`, "WEB_FETCH_TIMEOUT", true);
        }
        throw new PiEssentialsError(
          `Failed to fetch ${rawUrl}: ${errorMessage(error)}. Jina fallback also failed: ${errorMessage(fallbackError)}`,
          "WEB_FETCH_FAILED",
          true,
        );
      }
    }
    if (error instanceof PiEssentialsError) throw error;
    throw new PiEssentialsError(`Failed to fetch ${rawUrl}: ${errorMessage(error)}`, "WEB_FETCH_FAILED", true);
  }
}

async function fetchViaJina(
  rawUrl: string,
  config: ResolvedWebConfig["fetch"],
  signal: AbortSignal | undefined,
  slice: { offset?: number; limit?: number } | undefined,
  allowedHosts: ReadonlySet<string> | undefined,
): Promise<FetchPageResult> {
  const response = await safeFetch(`https://r.jina.ai/${rawUrl}`, {
    timeoutMs: config.timeoutMs,
    maxBytes: config.maxBytes,
    signal,
    allowedHosts,
    headers: { accept: "text/plain" },
  });
  const markdown = response.text() || "(Jina returned no readable text.)";
  return finish(rawUrl, rawUrl, markdown, config, slice);
}

function finish(
  url: string,
  title: string,
  markdown: string,
  config: ResolvedWebConfig["fetch"],
  slice: { offset?: number; limit?: number } | undefined,
): FetchPageResult {
  const id = putCache(url, title, markdown);
  const offset = Math.max(0, Math.floor(slice?.offset ?? 0));
  // Never ask for more than maxChars, so capText cannot add a second truncation
  // note on top of the slice note below.
  const limit = Math.min(config.maxChars, slice?.limit !== undefined ? Math.max(1, Math.floor(slice.limit)) : config.maxChars);
  const window = sliceMarkdown(markdown, offset, limit);
  const capped = capText(window.text, config.maxChars);
  const shown = capped.text.length;
  const truncated = capped.truncated || window.start + window.text.length < window.total || window.start > 0;
  return {
    url,
    title,
    markdown: truncated ? `${capped.text}\n\n${sliceNote(window.start, shown, window.total, id)}` : capped.text,
    truncated,
    cacheId: id,
    totalChars: window.total,
    offset: window.start,
  };
}

function sliceNote(start: number, shown: number, total: number, id: string): string {
  const end = Math.min(total, start + shown);
  if (end >= total) {
    return start === 0 ? "" : `[Showing characters ${start}-${end} of ${total}. End of cached page.]`;
  }
  return `[Showing characters ${start}-${end} of ${total}. Continue with web_fetch({ cacheId: "${id}", offset: ${end} }).]`;
}

export function readCached(idOrUrl: string, offset?: number, limit?: number, maxChars = 32_000): FetchPageResult {
  const entry = getCache(idOrUrl);
  if (!entry) {
    throw new PiEssentialsError(
      `No cached page for "${idOrUrl}". It may have expired; fetch the url again.`,
      "WEB_CACHE_MISS",
    );
  }
  const window = sliceMarkdown(entry.markdown, offset ?? 0, Math.min(maxChars, limit ?? maxChars));
  const capped = capText(window.text, maxChars);
  const shown = capped.text.length;
  const truncated = capped.truncated || window.start + shown < window.total || window.start > 0;
  return {
    url: entry.url,
    title: entry.title,
    markdown: truncated ? `${capped.text}\n\n${sliceNote(window.start, shown, window.total, entry.id)}` : capped.text,
    truncated,
    cacheId: entry.id,
    totalChars: window.total,
    offset: window.start,
  };
}

export function formatPage(result: FetchPageResult): string {
  return `# ${result.title}\nSource: ${result.url}\nCache-Id: ${result.cacheId}\n\n${result.markdown}`;
}
