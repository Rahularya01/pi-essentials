import type { ResolvedWebConfig, SearchProviderName } from "../config.ts";
import { isAbortError, PiEssentialsError } from "../errors.ts";
import { searchBrave } from "./providers/brave.ts";
import { searchDuckDuckGo } from "./providers/duckduckgo.ts";
import { searchExa } from "./providers/exa.ts";
import { searchJina } from "./providers/jina.ts";
import { searchSearxng } from "./providers/searxng.ts";
import { searchTavily } from "./providers/tavily.ts";
import type { SearchFn, SearchResult } from "./providers/types.ts";

export type ConcreteProvider = Exclude<SearchProviderName, "auto">;

/** Providers usable with the current configuration, best-first. */
export function availableProviders(config: ResolvedWebConfig["search"]): ConcreteProvider[] {
  const names: ConcreteProvider[] = [];
  if (config.searxngUrl) names.push("searxng");
  if (config.braveApiKey) names.push("brave");
  if (config.tavilyApiKey) names.push("tavily");
  if (config.exaApiKey) names.push("exa");
  if (config.jinaApiKey) names.push("jina");
  names.push("duckduckgo");
  return names;
}

export function providerFn(name: ConcreteProvider, config: ResolvedWebConfig["search"]): SearchFn {
  switch (name) {
    case "duckduckgo":
      return searchDuckDuckGo;
    case "brave":
      if (!config.braveApiKey) {
        throw new PiEssentialsError("Brave search requires web.search.braveApiKey or BRAVE_API_KEY.", "WEB_CONFIG");
      }
      return searchBrave(config.braveApiKey);
    case "tavily":
      if (!config.tavilyApiKey) {
        throw new PiEssentialsError("Tavily search requires web.search.tavilyApiKey or TAVILY_API_KEY.", "WEB_CONFIG");
      }
      return searchTavily(config.tavilyApiKey);
    case "exa":
      if (!config.exaApiKey) {
        throw new PiEssentialsError("Exa search requires web.search.exaApiKey or EXA_API_KEY.", "WEB_CONFIG");
      }
      return searchExa(config.exaApiKey);
    case "jina":
      return searchJina(config.jinaApiKey);
    case "searxng":
      if (!config.searxngUrl) {
        throw new PiEssentialsError("SearXNG search requires web.search.searxngUrl or SEARXNG_URL.", "WEB_CONFIG");
      }
      return searchSearxng(config.searxngUrl);
    default:
      throw new PiEssentialsError(`Unknown search provider: ${String(name)}`, "WEB_CONFIG");
  }
}

export async function runSearch(
  query: string,
  config: ResolvedWebConfig["search"],
  requested: SearchProviderName | undefined,
  count: number,
  signal?: AbortSignal,
  allowedHosts?: ReadonlySet<string>,
): Promise<SearchResult> {
  const options = { query, count, timeoutMs: config.timeoutMs, signal, allowedHosts };
  const explicit = requested && requested !== "auto" ? requested : config.provider !== "auto" ? config.provider : undefined;
  if (explicit) {
    return providerFn(explicit, config)(options);
  }

  const chain = availableProviders(config);
  let lastEmpty: SearchResult | undefined;
  let failed = 0;
  for (const name of chain) {
    if (signal?.aborted) throw new PiEssentialsError("Search was cancelled.", "WEB_SEARCH_CANCELLED");
    try {
      const result = await providerFn(name, config)(options);
      if (result.hits.length > 0) return result;
      lastEmpty = result;
    } catch (error) {
      // Cancellation is a caller decision, not a provider failure. In
      // particular, never continue the fallback chain after an aborted fetch.
      if (signal?.aborted || isAbortError(error)) {
        throw new PiEssentialsError("Search was cancelled.", "WEB_SEARCH_CANCELLED");
      }
      failed += 1;
    }
  }
  if (lastEmpty) return lastEmpty;
  throw new PiEssentialsError(failed > 0 ? "Search failed." : "No search results.", "WEB_SEARCH_FAILED", true);
}

export function formatSearch(result: SearchResult): string {
  const lines = [`Search for "${result.query}":`, ""];
  if (result.hits.length === 0) {
    lines.push("No results.");
  }
  result.hits.forEach((hit, index) => {
    lines.push(`${index + 1}. ${hit.title}`);
    lines.push(`   ${hit.url}`);
    if (hit.snippet) {
      const snippet = hit.snippet.length > 240 ? `${hit.snippet.slice(0, 239).trimEnd()}…` : hit.snippet;
      lines.push(`   ${snippet}`);
    }
    lines.push("");
  });
  if (result.notes) lines.push(result.notes);
  return lines.join("\n").trim();
}
