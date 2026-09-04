import { parseHTML } from "linkedom";
import { safeFetch } from "../http.ts";
import type { SearchFn, SearchHit } from "./types.ts";

function decodeDdgUrl(href: string): string {
  try {
    const url = new URL(href, "https://html.duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    if (uddg) return uddg;
    return url.href;
  } catch {
    return href;
  }
}

export const searchDuckDuckGo: SearchFn = async (query, count, signal) => {
  const target = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await safeFetch(target, {
    timeoutMs: 15_000,
    maxBytes: 512_000,
    signal,
    headers: { accept: "text/html" },
  });
  const { document } = parseHTML(response.text());
  const hits: SearchHit[] = [];
  const results = document.querySelectorAll(".result, .web-result, .links_main");
  for (const node of Array.from(results)) {
    const el = node as Element;
    const link = (el.querySelector("a.result__a, a.result-link, a") as Element | null) ?? null;
    const href = link?.getAttribute("href");
    const title = (link?.textContent ?? "").trim();
    const snippet = (el.querySelector(".result__snippet, .result-snippet, .snippet")?.textContent ?? "").trim();
    if (!href || !title) continue;
    const url = decodeDdgUrl(href);
    if (!url.startsWith("http")) continue;
    hits.push({ title, url, snippet, source: "duckduckgo" });
    if (hits.length >= count) break;
  }
  return { provider: "duckduckgo", query, hits };
};
