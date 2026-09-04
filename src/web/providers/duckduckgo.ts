import { parseHTML } from "linkedom";
import { safeFetch } from "../http.ts";
import { cleanSnippet, SEARCH_MAX_BYTES, toHits, type SearchFn } from "./types.ts";

/** DuckDuckGo wraps outbound links in /l/?uddg=<encoded>. Unwrap them. */
export function decodeDdgUrl(href: string): string {
  try {
    const url = new URL(href, "https://html.duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ?? url.href;
  } catch {
    return href;
  }
}

const RESULT_SELECTOR = ".result, .web-result, .links_main";
const AD_SELECTOR = ".result--ad, .results--ads, .badge--ad";

export const searchDuckDuckGo: SearchFn = async ({ query, count, timeoutMs, signal, allowedHosts }) => {
  const target = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await safeFetch(target, {
    timeoutMs,
    maxBytes: SEARCH_MAX_BYTES,
    signal,
    allowedHosts,
    headers: { accept: "text/html" },
  });
  const { document } = parseHTML(response.text());

  const rows: Array<{ title: string; url: string; snippet: string }> = [];
  for (const node of Array.from(document.querySelectorAll(RESULT_SELECTOR))) {
    const el = node as Element;
    if (el.matches?.(AD_SELECTOR) || el.querySelector(AD_SELECTOR)) continue;
    // Prefer the real result anchor; `querySelector` with a list returns document
    // order, not selector priority, so try each selector in turn.
    const link =
      el.querySelector("a.result__a") ??
      el.querySelector("a.result-link") ??
      el.querySelector("h2 a") ??
      el.querySelector("a[href]");
    const href = link?.getAttribute("href");
    const title = cleanSnippet(link?.textContent ?? "");
    if (!href || !title) continue;
    const url = decodeDdgUrl(href);
    if (!/^https?:\/\//i.test(url)) continue;
    const snippet = cleanSnippet(
      el.querySelector(".result__snippet")?.textContent ??
        el.querySelector(".result-snippet")?.textContent ??
        el.querySelector(".snippet")?.textContent ??
        "",
    );
    rows.push({ title, url, snippet });
  }

  if (rows.length === 0) {
    const blocked = /anomaly|unusual traffic|captcha/i.test(response.text().slice(0, 4000));
    if (blocked) throw new Error("DuckDuckGo rejected the request (rate limited). Configure another search provider.");
  }
  return { provider: "duckduckgo", query, hits: toHits(rows, count, "duckduckgo") };
};
