import { safeFetch } from "../http.ts";
import { parseJson, SEARCH_MAX_BYTES, toHits, type SearchFn } from "./types.ts";

export function searchTavily(apiKey: string): SearchFn {
  return async ({ query, count, timeoutMs, signal, allowedHosts }) => {
    const response = await safeFetch("https://api.tavily.com/search", {
      timeoutMs,
      maxBytes: SEARCH_MAX_BYTES,
      signal,
      allowedHosts,
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      // `api_key` is Tavily's legacy field and the Bearer header is the current
      // form; sending both keeps old and new deployments working.
      body: JSON.stringify({ api_key: apiKey, query, max_results: count, search_depth: "basic" }),
    });
    const json = parseJson<{
      results?: Array<{ title?: string; url?: string; content?: string }>;
    }>(response.text(), "Tavily");
    const hits = toHits(
      (json.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })),
      count,
      "tavily",
    );
    return { provider: "tavily", query, hits };
  };
}
