import { safeFetch } from "../http.ts";
import type { SearchFn, SearchHit } from "./types.ts";

export function searchBrave(apiKey: string): SearchFn {
  return async (query, count, signal) => {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
    const response = await safeFetch(url, {
      timeoutMs: 15_000,
      maxBytes: 512_000,
      signal,
      headers: {
        accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
    });
    const json = JSON.parse(response.text()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    const hits: SearchHit[] = (json.web?.results ?? [])
      .filter((r) => r.url && r.title)
      .slice(0, count)
      .map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.description ?? "",
        source: "brave",
      }));
    return { provider: "brave", query, hits };
  };
}
