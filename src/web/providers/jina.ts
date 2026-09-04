import { safeFetch } from "../http.ts";
import type { SearchFn, SearchHit } from "./types.ts";

export function searchJina(apiKey?: string): SearchFn {
  return async (query, count, signal) => {
    const headers: Record<string, string> = { accept: "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await safeFetch(`https://s.jina.ai/?q=${encodeURIComponent(query)}`, {
      timeoutMs: 20_000,
      maxBytes: 512_000,
      signal,
      headers,
    });
    const json = JSON.parse(response.text()) as {
      data?: Array<{ title?: string; url?: string; description?: string; content?: string }>;
    };
    const hits: SearchHit[] = (json.data ?? [])
      .filter((r) => r.url && r.title)
      .slice(0, count)
      .map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.description ?? r.content ?? "",
        source: "jina",
      }));
    return { provider: "jina", query, hits };
  };
}
