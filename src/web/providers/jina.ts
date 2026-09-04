import { safeFetch } from "../http.ts";
import { parseJson, SEARCH_MAX_BYTES, toHits, type SearchFn } from "./types.ts";

export function searchJina(apiKey?: string): SearchFn {
  return async ({ query, count, timeoutMs, signal, allowedHosts }) => {
    const headers: Record<string, string> = { accept: "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await safeFetch(`https://s.jina.ai/?q=${encodeURIComponent(query)}`, {
      timeoutMs,
      maxBytes: SEARCH_MAX_BYTES,
      signal,
      allowedHosts,
      headers,
    });
    const json = parseJson<{
      data?: Array<{ title?: string; url?: string; description?: string; content?: string }>;
    }>(response.text(), "Jina");
    const hits = toHits(
      (json.data ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.description ?? r.content })),
      count,
      "jina",
    );
    return { provider: "jina", query, hits };
  };
}
