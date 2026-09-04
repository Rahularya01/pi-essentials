import type { ResolvedWebConfig } from "../config.ts";
import { capText, errorMessage, PiEssentialsError } from "../errors.ts";
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
}

export async function fetchPage(
  rawUrl: string,
  config: ResolvedWebConfig["fetch"],
  signal?: AbortSignal,
): Promise<FetchPageResult> {
  try {
    const response = await safeFetch(rawUrl, {
      timeoutMs: config.timeoutMs,
      maxBytes: config.maxBytes,
      signal,
    });
    const contentType = response.contentType.toLowerCase();
    let markdown: string;
    let title = response.url;
    if (contentType.includes("json") || contentType.includes("text/plain") || contentType.includes("markdown")) {
      markdown = response.text();
    } else {
      const extracted = extractReadable(response.text(), response.url);
      markdown = extracted.markdown;
      title = extracted.title;
      if (extracted.byline) markdown = `${extracted.byline}\n\n${markdown}`;
    }
    const cacheId = putCache(response.url, title, markdown);
    const capped = capText(markdown, config.maxChars);
    return {
      url: response.url,
      title,
      markdown: capped.text,
      truncated: capped.truncated,
      cacheId,
      totalChars: markdown.length,
    };
  } catch (error) {
    if (config.jinaFallback && !(error instanceof SsrfError)) {
      try {
        return await fetchViaJina(rawUrl, config, signal);
      } catch (fallbackError) {
        throw new PiEssentialsError(
          `Failed to fetch ${rawUrl}: ${errorMessage(error)}. Jina fallback also failed: ${errorMessage(fallbackError)}`,
          "WEB_FETCH_FAILED",
          true,
        );
      }
    }
    if (error instanceof PiEssentialsError || error instanceof SsrfError) throw error;
    throw new PiEssentialsError(`Failed to fetch ${rawUrl}: ${errorMessage(error)}`, "WEB_FETCH_FAILED", true);
  }
}

async function fetchViaJina(
  rawUrl: string,
  config: ResolvedWebConfig["fetch"],
  signal?: AbortSignal,
): Promise<FetchPageResult> {
  const response = await safeFetch(`https://r.jina.ai/${rawUrl}`, {
    timeoutMs: config.timeoutMs,
    maxBytes: config.maxBytes,
    signal,
    headers: { accept: "text/plain" },
  });
  const markdown = response.text();
  const cacheId = putCache(rawUrl, rawUrl, markdown);
  const capped = capText(markdown, config.maxChars);
  return {
    url: rawUrl,
    title: rawUrl,
    markdown: capped.text,
    truncated: capped.truncated,
    cacheId,
    totalChars: markdown.length,
  };
}

export function readCached(idOrUrl: string, offset?: number, limit?: number): FetchPageResult {
  const entry = getCache(idOrUrl);
  if (!entry) throw new PiEssentialsError(`No cached page for "${idOrUrl}". Fetch it first.`, "WEB_CACHE_MISS");
  const slice = sliceMarkdown(entry.markdown, offset ?? 0, limit);
  const truncated = slice.text.length < slice.total;
  return {
    url: entry.url,
    title: entry.title,
    markdown: truncated
      ? `${slice.text}\n\n[Showing ${slice.text.length} of ${slice.total} characters starting at offset ${offset ?? 0}.]`
      : slice.text,
    truncated,
    cacheId: entry.id,
    totalChars: slice.total,
  };
}

export function formatPage(result: FetchPageResult): string {
  const header = `# ${result.title}\nSource: ${result.url}\nCache-Id: ${result.cacheId}\n`;
  return `${header}\n${result.markdown}`;
}
