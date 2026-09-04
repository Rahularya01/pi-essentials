import { safeFetch } from "../http.ts";
import type { SearchFn, SearchHit } from "./types.ts";

export function searchTavily(apiKey: string): SearchFn {
  return async (query, count, signal) => {
    const response = await safeFetch("https://api.tavily.com/search", {
      timeoutMs: 20_000,
      maxBytes: 512_000,
      signal,
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ api_key: apiKey, query, max_results: count, search_depth: "basic" }),
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
        source: "tavily",
      }));
    return { provider: "tavily", query, hits };
  };
}
