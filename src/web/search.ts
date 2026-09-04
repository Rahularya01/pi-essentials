import type { ResolvedWebConfig, SearchProviderName } from "../config.ts";
import { errorMessage, PiEssentialsError } from "../errors.ts";
import { searchBrave } from "./providers/brave.ts";
import { searchDuckDuckGo } from "./providers/duckduckgo.ts";
import { searchExa } from "./providers/exa.ts";
import { searchJina } from "./providers/jina.ts";
import { searchSearxng } from "./providers/searxng.ts";
import { searchTavily } from "./providers/tavily.ts";
import type { SearchFn, SearchResult } from "./providers/types.ts";

export function availableProviders(config: ResolvedWebConfig["search"]): Array<Exclude<SearchProviderName, "auto">> {
  const names: Array<Exclude<SearchProviderName, "auto">> = [];
  if (config.searxngUrl) names.push("searxng");
  if (config.braveApiKey) names.push("brave");
  if (config.tavilyApiKey) names.push("tavily");
  if (config.exaApiKey) names.push("exa");
  if (config.jinaApiKey) names.push("jina");
  names.push("duckduckgo");
  return names;
}

export function providerFn(name: Exclude<SearchProviderName, "auto">, config: ResolvedWebConfig["search"]): SearchFn {
  switch (name) {
    case "duckduckgo":
      return searchDuckDuckGo;
    case "brave":
      if (!config.braveApiKey) throw new PiEssentialsError("Brave search requires web.search.braveApiKey or BRAVE_API_KEY.", "WEB_CONFIG");
      return searchBrave(config.braveApiKey);
    case "tavily":
      if (!config.tavilyApiKey) throw new PiEssentialsError("Tavily search requires web.search.tavilyApiKey or TAVILY_API_KEY.", "WEB_CONFIG");
      return searchTavily(config.tavilyApiKey);
    case "exa":
      if (!config.exaApiKey) throw new PiEssentialsError("Exa search requires web.search.exaApiKey or EXA_API_KEY.", "WEB_CONFIG");
      return searchExa(config.exaApiKey);
    case "jina":
      return searchJina(config.jinaApiKey);
    case "searxng":
      if (!config.searxngUrl) throw new PiEssentialsError("SearXNG search requires web.search.searxngUrl.", "WEB_CONFIG");
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
): Promise<SearchResult> {
  const provider = requested && requested !== "auto" ? requested : config.provider;
  if (provider && provider !== "auto") {
    return providerFn(provider, config)(query, count, signal ?? AbortSignal.timeout(config.timeoutMs));
  }

  const chain = availableProviders(config);
  const errors: string[] = [];
  for (const name of chain) {
    try {
      const result = await providerFn(name, config)(query, count, signal ?? AbortSignal.timeout(config.timeoutMs));
      if (result.hits.length > 0) {
        if (errors.length > 0) result.notes = `Used ${name} after earlier failures: ${errors.join("; ")}`;
        return result;
      }
      errors.push(`${name}: no results`);
    } catch (error) {
      errors.push(`${name}: ${errorMessage(error)}`);
    }
  }
  throw new PiEssentialsError(`All search providers failed. ${errors.join(" | ")}`, "WEB_SEARCH_FAILED", true);
}

export function formatSearch(result: SearchResult): string {
  const lines = [`Search (${result.provider}) for "${result.query}":`, ""];
  if (result.hits.length === 0) lines.push("No results.");
  result.hits.forEach((hit, index) => {
    lines.push(`${index + 1}. ${hit.title}`);
    lines.push(`   ${hit.url}`);
    if (hit.snippet) lines.push(`   ${hit.snippet}`);
    lines.push("");
  });
  if (result.notes) lines.push(result.notes);
  return lines.join("\n").trim();
}
