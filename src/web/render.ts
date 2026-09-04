import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  body,
  failLine,
  firstText,
  formatCount,
  GLYPH,
  meta,
  okLine,
  oneLine,
  safeRender,
  shortUrl,
  titleLine,
  type RenderableResult,
  type RenderSlot,
} from "../ui/render.ts";
import type { SearchHit } from "./providers/types.ts";

interface SearchDetails {
  provider?: string;
  query?: string;
  hits?: SearchHit[];
}

interface FetchDetails {
  url?: string;
  title?: string;
  totalChars?: number;
  truncated?: boolean;
  cacheId?: string;
  offset?: number;
}

export function renderSearchCall(
  args: { query?: string; provider?: string; numResults?: number },
  theme: Theme,
  context: RenderSlot,
): Text {
  return safeRender(
    () =>
      titleLine(theme, "web_search", args?.query ? `"${oneLine(args.query, 56)}"` : undefined) +
      meta(theme, [
        args?.provider && args.provider !== "auto" ? args.provider : undefined,
        args?.numResults ? `${args.numResults} results` : undefined,
      ]),
    "web_search",
    context,
  );
}

export function renderSearchResult(
  result: RenderableResult<SearchDetails | undefined>,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: RenderSlot,
): Text {
  return safeRender(
    () => {
      if (options.isPartial) return theme.fg("muted", `${GLYPH.sep} searching…`);
      if (context.isError) return failLine(theme, oneLine(firstText(result) || "search failed", 96));

      const hits = result?.details?.hits ?? [];
      const provider = result?.details?.provider;
      if (hits.length === 0) {
        return `${theme.fg("warning", GLYPH.pending)} ${theme.fg("muted", "no results")}${meta(theme, [provider])}`;
      }

      const header = okLine(theme, theme.fg("text", `${hits.length} results`)) + meta(theme, [provider]);
      const lines = hits.map(
        (hit, index) =>
          `${theme.fg("dim", `${index + 1}.`)} ${theme.fg("text", oneLine(hit.title, 60))}\n     ${theme.fg("mdLinkUrl", shortUrl(hit.url, 64))}`,
      );
      return header + body(theme, lines, options.expanded, { limit: 3, indent: "  ", noun: "result" });
    },
    oneLine(firstText(result), 120),
    context,
  );
}

export function renderFetchCall(
  args: { url?: string; cacheId?: string; offset?: number; limit?: number },
  theme: Theme,
  context: RenderSlot,
): Text {
  return safeRender(
    () => {
      const subject = args?.url ? shortUrl(args.url, 58) : args?.cacheId ? `cache ${args.cacheId}` : undefined;
      return (
        titleLine(theme, "web_fetch", subject) +
        meta(theme, [
          args?.offset ? `from ${formatCount(args.offset)}` : undefined,
          args?.limit ? `${formatCount(args.limit)} chars` : undefined,
        ])
      );
    },
    "web_fetch",
    context,
  );
}

export function renderFetchResult(
  result: RenderableResult<FetchDetails | undefined>,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: RenderSlot,
): Text {
  return safeRender(
    () => {
      if (options.isPartial) return theme.fg("muted", `${GLYPH.sep} fetching…`);
      if (context.isError) return failLine(theme, oneLine(firstText(result) || "fetch failed", 96));

      const details = result?.details ?? {};
      const title = details.title && details.title !== details.url ? details.title : shortUrl(details.url ?? "", 52);
      const header =
        okLine(theme, theme.fg("text", oneLine(title, 58))) +
        meta(theme, [
          details.totalChars ? `${formatCount(details.totalChars)} chars` : undefined,
          details.truncated ? "truncated" : undefined,
          details.cacheId ? `id ${details.cacheId}` : undefined,
        ]);

      // The result text carries the `# title / Source: / Cache-Id:` preamble;
      // the header already says all of that, so preview the body instead.
      const text = firstText(result);
      const preview = text.split("\n").slice(4).filter((line) => line.trim().length > 0);
      return header + body(theme, preview.map((line) => theme.fg("toolOutput", oneLine(line, 100))), options.expanded, {
        limit: 2,
      });
    },
    oneLine(firstText(result), 120),
    context,
  );
}
