import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ResolvedConfig } from "../config.ts";
import { errorMessage, PiEssentialsError, toolError, toolText } from "../errors.ts";
import { MAX_SEARCH_RESULTS } from "../security/limits.ts";
import { formatPage, fetchPage, readCached } from "./fetch.ts";
import { formatSearch, runSearch } from "./search.ts";

export function registerWeb(pi: ExtensionAPI, config: ResolvedConfig): void {
  const searchCfg = config.web.search;
  const fetchCfg = config.web.fetch;

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web and return titles, URLs, and snippets. Use provider=auto unless you need a specific backend. Then fetch promising URLs with web_fetch.",
    promptSnippet: "Search the public web and return cited snippets",
    promptGuidelines: [
      "Use web_search for current or external information, then web_fetch for pages you actually need to read.",
      "Do not dump search HTML; prefer the returned title/url/snippet list.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      numResults: Type.Optional(Type.Number({ description: "Results to return (1-20)" })),
      provider: Type.Optional(
        StringEnum(["auto", "duckduckgo", "brave", "tavily", "exa", "jina", "searxng"] as const, {
          description: "Search provider. auto uses the configured fallback chain.",
        }),
      ),
    }),
    async execute(_id, params, signal, onUpdate) {
      try {
        const query = params.query.trim();
        if (!query) return toolError("query is required");
        const count = Math.min(MAX_SEARCH_RESULTS, Math.max(1, params.numResults ?? searchCfg.maxResults));
        onUpdate?.(toolText(`Searching for "${query}"...`));
        const result = await runSearch(query, searchCfg, params.provider, count, signal);
        return toolText(formatSearch(result), { provider: result.provider, hits: result.hits });
      } catch (error) {
        return toolError(error instanceof PiEssentialsError ? error.message : errorMessage(error));
      }
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a URL and return readable markdown. Large pages are truncated; pass cacheId with offset/limit to read more. Does not execute page JavaScript.",
    promptSnippet: "Fetch a webpage as readable markdown",
    promptGuidelines: [
      "Use web_fetch to read a specific URL after web_search, instead of dumping raw HTML.",
      "If the result is truncated, call web_fetch again with the returned cacheId and an offset.",
    ],
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "http(s) URL to fetch" })),
      cacheId: Type.Optional(Type.String({ description: "Previously returned cache id" })),
      offset: Type.Optional(Type.Number({ description: "Character offset into cached content" })),
      limit: Type.Optional(Type.Number({ description: "Maximum characters to return from cache" })),
    }),
    async execute(_id, params, signal, onUpdate) {
      try {
        if (params.cacheId) {
          const cached = readCached(params.cacheId, params.offset, params.limit);
          return toolText(formatPage(cached), cached);
        }
        if (!params.url?.trim()) return toolError("url or cacheId is required");
        onUpdate?.(toolText(`Fetching ${params.url}...`));
        const page = await fetchPage(params.url.trim(), fetchCfg, signal);
        return toolText(formatPage(page), page);
      } catch (error) {
        return toolError(error instanceof PiEssentialsError ? error.message : errorMessage(error));
      }
    },
  });
}
