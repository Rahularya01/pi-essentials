import { safeFetch } from "../http.ts";
import type { SearchFn, SearchHit } from "./types.ts";

export function searchExa(apiKey: string): SearchFn {
  return async (query, count, signal) => {
    const response = await safeFetch("https://api.exa.ai/search", {
      timeoutMs: 20_000,
      maxBytes: 512_000,
      signal,
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({ query, numResults: count, type: "auto", contents: { text: { maxCharacters: 400 } } }),
    });
    const json = JSON.parse(response.text()) as {
      results?: Array<{ title?: string; url?: string; text?: string; snippet?: string }>;
    };
    const hits: SearchHit[] = (json.results ?? [])
      .filter((r) => r.url && r.title)
      .slice(0, count)
      .map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.snippet ?? r.text ?? "",
        source: "exa",
      }));
    return { provider: "exa", query, hits };
  };
}
