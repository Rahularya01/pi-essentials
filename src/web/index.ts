import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ResolvedConfig } from "../config.ts";
import { errorMessage, PiEssentialsError, toolFailure, toolText } from "../errors.ts";
import { MAX_SEARCH_RESULTS } from "../security/limits.ts";
import { SsrfError } from "../security/ssrf.ts";
import { ActivityLog, activityWidget, fetchDetail, searchDetail } from "./activity.ts";
import { formatPage, fetchPage, readCached } from "./fetch.ts";
import { renderFetchCall, renderFetchResult, renderSearchCall, renderSearchResult } from "./render.ts";
import { formatSearch, runSearch } from "./search.ts";

function describeError(error: unknown): string {
  if (error instanceof SsrfError) return `${error.message} (blocked for safety)`;
  if (error instanceof PiEssentialsError) return error.message;
  return errorMessage(error);
}

function optionalInteger(
  value: number | undefined,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    toolFailure(`${name} must be an integer from ${minimum} to ${maximum}.`, "WEB_BAD_ARGS");
  }
  return value;
}

export function resolveSearchCount(
  params: { numResults?: number; limit?: number; num_search_results?: number },
  fallback: number,
): number {
  const requested = params.numResults ?? params.limit ?? params.num_search_results ?? fallback;
  return optionalInteger(requested, "result count", 1, MAX_SEARCH_RESULTS) as number;
}

/** Rows the activity panel shows before it summarizes the rest. */
const ACTIVITY_ROWS = 6;

export function registerWeb(pi: ExtensionAPI, config: ResolvedConfig): void {
  const searchCfg = config.web.search;
  const fetchCfg = config.web.fetch;
  const allowedHosts = config.web.allowedHosts;
  const activity = new ActivityLog();
  let panelVisible = false;
  let collapsed = false;

  const renderActivity = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (!panelVisible || activity.size === 0) {
      ctx.ui.setWidget("pi-essentials-web", undefined);
      return;
    }
    ctx.ui.setWidget(
      "pi-essentials-web",
      (_tui, theme) =>
        new Text(activityWidget(theme, activity, { collapsed, maxRows: ACTIVITY_ROWS }).join("\n"), 0, 0),
      { placement: "belowEditor" },
    );
  };

  // Off by default so the panel never competes with the transcript; the
  // shortcut brings it up when a search or fetch needs explaining.
  pi.registerShortcut("ctrl+shift+w", {
    description: "Show or hide the pi-essentials web activity panel",
    handler: async (ctx) => {
      if (!panelVisible) {
        panelVisible = true;
        collapsed = false;
      } else if (!collapsed) {
        collapsed = true;
      } else {
        panelVisible = false;
        collapsed = false;
      }
      renderActivity(ctx);
      if (!panelVisible) ctx.ui.notify("Web activity panel hidden", "info");
    },
  });

  pi.registerCommand("web", {
    description: "Show recent web_search and web_fetch activity. Usage: /web [clear]",
    handler: async (args, ctx) => {
      if (args.trim().toLowerCase() === "clear") {
        activity.clear();
        renderActivity(ctx);
        ctx.ui.notify("Cleared web activity.", "info");
        return;
      }
      if (activity.size === 0) {
        ctx.ui.notify("No web activity yet this session.", "info");
        return;
      }
      panelVisible = true;
      collapsed = false;
      renderActivity(ctx);
      const rows = activity
        .recent(activity.size)
        .map(
          (entry) =>
            `${entry.ok ? "✓" : "✗"} ${entry.kind === "search" ? "SEARCH" : "FETCH "} ${entry.subject} — ${entry.detail ?? ""} (${Math.round(entry.ms)}ms)`,
        );
      ctx.ui.notify(rows.join("\n"), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    activity.clear();
    panelVisible = false;
    collapsed = false;
    renderActivity(ctx);
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web and return titles, URLs, and snippets. Then fetch promising URLs with web_fetch.",
    promptSnippet: "Search the public web and return cited snippets",
    promptGuidelines: [
      "Use web_search for current or external information, then web_fetch for pages you actually need to read.",
      "Do not dump search HTML; prefer the returned title/url/snippet list.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      numResults: Type.Optional(
        Type.Integer({ minimum: 1, maximum: MAX_SEARCH_RESULTS, description: `Results to return (1-${MAX_SEARCH_RESULTS})` }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: MAX_SEARCH_RESULTS, description: "Alias for numResults" }),
      ),
      num_search_results: Type.Optional(
        Type.Integer({ minimum: 1, maximum: MAX_SEARCH_RESULTS, description: "Alias for numResults" }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const query = params.query?.trim();
      if (!query) toolFailure("query is required.", "WEB_BAD_ARGS");

      const count = resolveSearchCount(params, searchCfg.maxResults);

      onUpdate?.(toolText(`Searching for "${query}"...`));
      try {
        const result = await activity.track(
          "search",
          query,
          () => runSearch(query, searchCfg, "auto", count, signal, allowedHosts),
          searchDetail,
        );
        renderActivity(ctx);
        return toolText(formatSearch(result), { hits: result.hits, query });
      } catch (error) {
        renderActivity(ctx);
        toolFailure(
          describeError(error),
          error instanceof PiEssentialsError ? error.code : "WEB_SEARCH_FAILED",
        );
      }
    },
    renderCall: renderSearchCall,
    renderResult: renderSearchResult,
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
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset into the page text" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum characters to return" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const offset = optionalInteger(params.offset, "offset", 0);
      const limit = optionalInteger(params.limit, "limit", 1);
      const cacheId = params.cacheId?.trim();
      const url = params.url?.trim();
      if ((!cacheId && !url) || (cacheId && url)) {
        toolFailure("Provide exactly one of url or cacheId.", "WEB_BAD_ARGS");
      }

      try {
        if (cacheId) {
          const cached = readCached(cacheId, offset, limit, fetchCfg.maxChars);
          return toolText(formatPage(cached), cached);
        }
        onUpdate?.(toolText(`Fetching ${url}...`));
        const page = await activity.track(
          "fetch",
          url as string,
          () => fetchPage(url as string, fetchCfg, signal, { offset, limit }, allowedHosts),
          fetchDetail,
        );
        renderActivity(ctx);
        return toolText(formatPage(page), page);
      } catch (error) {
        renderActivity(ctx);
        toolFailure(describeError(error), error instanceof PiEssentialsError ? error.code : "WEB_FETCH_FAILED");
      }
    },
    renderCall: renderFetchCall,
    renderResult: renderFetchResult,
  });
}
