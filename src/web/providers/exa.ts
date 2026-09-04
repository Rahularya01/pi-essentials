import { safeFetch } from "../http.ts";
import { parseJson, SEARCH_MAX_BYTES, toHits, type SearchFn } from "./types.ts";

export function searchExa(apiKey: string): SearchFn {
  return async ({ query, count, timeoutMs, signal, allowedHosts }) => {
    const response = await safeFetch("https://api.exa.ai/search", {
      timeoutMs,
      maxBytes: SEARCH_MAX_BYTES,
      signal,
      allowedHosts,
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({ query, numResults: count, type: "auto", contents: { text: { maxCharacters: 400 } } }),
    });
    const json = parseJson<{
      results?: Array<{ title?: string; url?: string; text?: string; snippet?: string }>;
    }>(response.text(), "Exa");
    const hits = toHits(
      (json.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.snippet ?? r.text })),
      count,
      "exa",
    );
    return { provider: "exa", query, hits };
  };
}
