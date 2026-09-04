import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { htmlToMarkdown } from "./html-to-markdown.ts";

export interface ExtractedPage {
  title: string;
  url: string;
  markdown: string;
  byline?: string;
}

export function extractReadable(html: string, url: string): ExtractedPage {
  const { document } = parseHTML(html);
  try {
    document.documentElement.setAttribute("lang", document.documentElement.getAttribute("lang") ?? "en");
  } catch {
    // ignore
  }

  let title = "";
  try {
    title = document.title?.trim() ?? "";
  } catch {
    title = "";
  }

  let markdown = "";
  let byline: string | undefined;
  try {
    const cloned = document.cloneNode(true) as typeof document;
    const article = new Readability(cloned as unknown as Document, { charThreshold: 80 }).parse();
    if (article?.content) {
      const parsed = parseHTML(`<div id="pi-essentials-article">${article.content}</div>`);
      markdown = htmlToMarkdown(parsed.document.body);
      title = article.title?.trim() || title;
      byline = article.byline?.trim() || undefined;
    }
  } catch {
    markdown = "";
  }

  if (!markdown.trim()) {
    markdown = htmlToMarkdown(document);
  }

  if (!markdown.trim()) {
    markdown = (document.body?.textContent ?? document.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  return { title: title || url, url, markdown, byline };
}
