import { safeFetch } from "../http.ts";
import { parseJson, SEARCH_MAX_BYTES, toHits, type SearchFn } from "./types.ts";

export function searchBrave(apiKey: string): SearchFn {
  return async ({ query, count, timeoutMs, signal, allowedHosts }) => {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
    const response = await safeFetch(url, {
      timeoutMs,
      maxBytes: SEARCH_MAX_BYTES,
      signal,
      allowedHosts,
      headers: {
        accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
    });
    const json = parseJson<{
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    }>(response.text(), "Brave");
    const hits = toHits(
      (json.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.description })),
      count,
      "brave",
    );
    return { provider: "brave", query, hits };
  };
}
