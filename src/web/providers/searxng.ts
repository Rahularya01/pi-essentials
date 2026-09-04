import { safeFetch } from "../http.ts";
import { parseJson, SEARCH_MAX_BYTES, toHits, type SearchFn } from "./types.ts";

export function searchSearxng(baseUrl: string): SearchFn {
  return async ({ query, count, timeoutMs, signal, allowedHosts }) => {
    const url = new URL(baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/search`;
    url.search = "";
    url.hash = "";
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    const response = await safeFetch(url.toString(), {
      timeoutMs,
      maxBytes: SEARCH_MAX_BYTES,
      signal,
      allowedHosts,
      headers: { accept: "application/json" },
    });
    const json = parseJson<{
      results?: Array<{ title?: string; url?: string; content?: string }>;
    }>(response.text(), "SearXNG");
    const hits = toHits(
      (json.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })),
      count,
      "searxng",
    );
    return { provider: "searxng", query, hits };
  };
}
