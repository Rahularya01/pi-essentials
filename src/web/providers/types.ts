export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export interface SearchResult {
  provider: string;
  query: string;
  hits: SearchHit[];
  notes?: string;
}

export interface SearchOptions {
  query: string;
  /** Maximum hits to return. */
  count: number;
  /** Per-request timeout from `web.search.timeoutMs`. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Private hosts the user explicitly trusts (for example a local SearXNG). */
  allowedHosts?: ReadonlySet<string>;
}

export type SearchFn = (options: SearchOptions) => Promise<SearchResult>;

/** Response cap for search APIs; result payloads are small compared to pages. */
export const SEARCH_MAX_BYTES = 1024 * 1024;

/** Collapse whitespace and drop empty snippets so terminal output stays compact. */
export function cleanSnippet(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** Parse, canonicalize, and limit search results to fetchable web URLs. */
export function normalizeResultUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

export function toHits(
  rows: Array<{ title?: string; url?: string; snippet?: string }>,
  count: number,
  source: string,
): SearchHit[] {
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const row of rows) {
    const url = normalizeResultUrl(row.url);
    const title = cleanSnippet(row.title);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    hits.push({ title, url, snippet: cleanSnippet(row.snippet), source });
    if (hits.length >= count) break;
  }
  return hits;
}

/** Parse a JSON search response with a provider-specific error message on failure. */
export function parseJson<T>(text: string, provider: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    const preview = text.replace(/\s+/g, " ").trim().slice(0, 200);
    throw new Error(`${provider} returned a non-JSON response${preview ? `: ${preview}` : "."}`);
  }
}
