import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { htmlToMarkdown } from "./html-to-markdown.ts";

export interface ExtractedPage {
  title: string;
  url: string;
  markdown: string;
  byline?: string;
}

/** Page chrome to drop when Readability cannot identify an article. */
const CHROME_SELECTOR = "nav, header, footer, aside, form, [role=navigation], [role=banner], [role=contentinfo]";

const TITLE_META = [
  'meta[property="og:title"]',
  'meta[name="og:title"]',
  'meta[name="twitter:title"]',
  'meta[name="title"]',
];

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Resolve a page title from the most reliable source available.
 *
 * `document.title` is deliberately not trusted: linkedom returns an empty string
 * for it on real-world pages whose `<head>` it parses loosely, even when a
 * `<title>` element is present and reachable via `querySelector`.
 */
export function extractTitle(document: Document | ReturnType<typeof parseHTML>["document"]): string {
  const tag = clean(document.querySelector?.("title")?.textContent);
  if (tag) return tag;
  for (const selector of TITLE_META) {
    const meta = clean(document.querySelector?.(selector)?.getAttribute("content"));
    if (meta) return meta;
  }
  return clean(document.querySelector?.("h1")?.textContent);
}

export function extractReadable(html: string, url: string): ExtractedPage {
  const { document } = parseHTML(html);
  let title = extractTitle(document);

  let markdown = "";
  let byline: string | undefined;
  try {
    // Readability mutates the document it is given, so parse a second copy.
    const article = new Readability(parseHTML(html).document as unknown as Document, { charThreshold: 80 }).parse();
    if (article?.content) {
      const parsed = parseHTML(`<div>${article.content}</div>`);
      markdown = htmlToMarkdown(parsed.document.body);
      // Readability's title is cleaner when it finds one, but it is often empty.
      title = clean(article.title) || title;
      byline = clean(article.byline) || undefined;
    }
  } catch {
    markdown = "";
  }

  if (!markdown.trim()) {
    for (const node of Array.from(document.querySelectorAll(CHROME_SELECTOR))) {
      node.remove?.();
    }
    markdown = htmlToMarkdown(document);
  }

  if (!markdown.trim()) {
    markdown = clean(document.body?.textContent ?? document.textContent);
  }

  return { title: title || url, url, markdown, byline };
}
