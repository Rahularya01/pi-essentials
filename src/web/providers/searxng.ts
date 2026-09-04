import { safeFetch } from "../http.ts";
import type { SearchFn, SearchHit } from "./types.ts";

export function searchSearxng(baseUrl: string): SearchFn {
  return async (query, count, signal) => {
    const root = baseUrl.replace(/\/+$/, "");
    const url = `${root}/search?q=${encodeURIComponent(query)}&format=json`;
    const response = await safeFetch(url, {
      timeoutMs: 15_000,
      maxBytes: 512_000,
      signal,
      headers: { accept: "application/json" },
    });
    const json = JSON.parse(response.text()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    const hits: SearchHit[] = (json.results ?? [])
      .filter((r) => r.url && r.title)
      .slice(0, count)
      .map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.content ?? "",
        source: "searxng",
      }));
    return { provider: "searxng", query, hits };
  };
}
