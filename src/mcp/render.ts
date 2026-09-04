import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  body,
  failLine,
  firstText,
  formatBytes,
  GLYPH,
  meta,
  okLine,
  oneLine,
  safeRender,
  type RenderableResult,
  type RenderSlot,
} from "../ui/render.ts";
import type { CachedTool, ServerSnapshot } from "./types.ts";

interface McpDetails {
  action?: string;
  tools?: CachedTool[];
  matches?: CachedTool[];
  tool?: CachedTool | string;
  servers?: ServerSnapshot[];
  server?: string;
  total?: number;
}

interface McpArgs {
  action?: string;
  query?: string;
  tool?: string;
  server?: string;
  args?: unknown;
}

/** One-line preview of the arguments a proxied MCP call was given. */
function previewArgs(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!text || text === "{}") return undefined;
    return oneLine(text, 48);
  } catch {
    return undefined;
  }
}

export function renderMcpCall(args: McpArgs, theme: Theme, context: RenderSlot): Text {
  return safeRender(
    () => {
      const action = args?.action ?? "";
      const subject =
        action === "search"
          ? args?.query && `"${args.query}"`
          : action === "call" || action === "describe"
            ? args?.tool
            : args?.server;
      let line = theme.fg("toolTitle", theme.bold("mcp"));
      if (action) line += ` ${theme.fg("accent", action)}`;
      if (subject) line += ` ${theme.fg("text", oneLine(String(subject), 52))}`;
      return line + meta(theme, [action === "call" ? previewArgs(args?.args) : undefined]);
    },
    "mcp",
    context,
  );
}

export function renderMcpResult(
  result: RenderableResult<McpDetails | undefined>,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: RenderSlot,
): Text {
  return safeRender(
    () => {
      const text = firstText(result);
      if (options.isPartial) return theme.fg("muted", `${GLYPH.sep} ${oneLine(text, 60) || "working…"}`);
      if (context.isError) return failLine(theme, oneLine(text || "mcp call failed", 96));

      const details = result?.details ?? {};

      if (details.action === "status" && details.servers) {
        const rows = details.servers.map((server) => statusRow(theme, server));
        const connected = details.servers.filter((s) => s.status === "connected").length;
        return (
          okLine(theme, theme.fg("text", `${details.servers.length} servers`)) +
          meta(theme, [`${connected} connected`]) +
          body(theme, rows, options.expanded, { limit: 6, noun: "server" })
        );
      }

      if (details.action === "search" || details.action === "list") {
        const tools = details.matches ?? details.tools ?? [];
        if (tools.length === 0) return `${theme.fg("warning", GLYPH.pending)} ${theme.fg("muted", oneLine(text, 80))}`;
        const rows = tools.map(
          (tool) =>
            `${theme.fg("accent", tool.prefixedName)}${theme.fg("dim", ` ${GLYPH.sep} ${oneLine(tool.description || "no description", 56)}`)}`,
        );
        return (
          okLine(theme, theme.fg("text", `${details.total ?? tools.length} tools`)) +
          body(theme, rows, options.expanded, { limit: 4, noun: "tool" })
        );
      }

      if (details.action === "describe") {
        const tool = typeof details.tool === "object" ? details.tool : undefined;
        return (
          okLine(theme, theme.fg("accent", tool?.prefixedName ?? "tool")) +
          meta(theme, [tool?.server]) +
          body(theme, text.split("\n").slice(1).map((line) => theme.fg("toolOutput", oneLine(line, 100))), options.expanded, {
            limit: 2,
          })
        );
      }

      // call / auth / disconnect: show the payload size and a preview.
      const lines = text.split("\n").filter((line) => line.trim().length > 0);
      const header =
        okLine(theme, theme.fg("text", typeof details.tool === "string" ? details.tool : (details.action ?? "done"))) +
        meta(theme, [sizeNote(text)]);
      return header + body(theme, lines.map((line) => theme.fg("toolOutput", oneLine(line, 100))), options.expanded, {
        limit: 2,
      });
    },
    oneLine(firstText(result), 120),
    context,
  );
}

/** Payload size is only worth showing once a result is genuinely large. */
function sizeNote(text: string): string | undefined {
  const bytes = Buffer.byteLength(text, "utf8");
  return bytes >= 1024 ? formatBytes(bytes) : undefined;
}

function statusRow(theme: Theme, server: ServerSnapshot): string {
  const color =
    server.status === "connected"
      ? "success"
      : server.status === "failed"
        ? "error"
        : server.status === "needs-auth"
          ? "warning"
          : "muted";
  const glyph = server.status === "connected" ? GLYPH.ok : server.status === "failed" ? GLYPH.fail : GLYPH.pending;
  return (
    `${theme.fg(color, glyph)} ${theme.fg("text", server.name)}` +
    theme.fg("dim", ` ${GLYPH.sep} ${server.status} ${GLYPH.sep} ${server.transport} ${GLYPH.sep} ${server.toolCount} tools`)
  );
}

/** Footer status: `mcp 2/3` with a warning tint when a server needs attention. */
export function mcpStatusText(servers: ServerSnapshot[]): string | undefined {
  const active = servers.filter((server) => server.status !== "disabled");
  if (active.length === 0) return undefined;
  const connected = active.filter((server) => server.status === "connected").length;
  const needsAuth = active.filter((server) => server.status === "needs-auth").length;
  const failed = active.filter((server) => server.status === "failed").length;

  let text = `⚡ mcp ${connected}/${active.length}`;
  if (needsAuth > 0) text += ` ${GLYPH.sep} ${needsAuth} need auth`;
  if (failed > 0) text += ` ${GLYPH.sep} ${failed} failed`;
  return text;
}
