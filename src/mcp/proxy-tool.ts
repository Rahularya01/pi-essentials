import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { errorMessage, PiEssentialsError, toolFailure, toolText } from "../errors.ts";
import type { McpManager } from "./manager.ts";
import { renderMcpCall, renderMcpResult } from "./render.ts";
import type { CachedTool } from "./types.ts";

/** Cap on tools echoed back to the model so a large fleet cannot flood context. */
const MAX_SEARCH_MATCHES = 20;
const MAX_LIST_TOOLS = 200;

const McpParams = Type.Object({
  action: StringEnum(["search", "describe", "call", "list", "status", "auth", "disconnect"] as const, {
    description: "MCP action to perform",
  }),
  query: Type.Optional(Type.String({ description: "Search query (action=search)" })),
  tool: Type.Optional(Type.String({ description: "Prefixed or original tool name (describe/call)" })),
  args: Type.Optional(Type.Any({ description: "JSON object or JSON string of tool arguments (call)" })),
  server: Type.Optional(Type.String({ description: "Server name (auth/disconnect)" })),
  redirectUrl: Type.Optional(Type.String({ description: "OAuth callback URL to complete auth" })),
});

function formatTool(tool: CachedTool): string {
  const schema = tool.inputSchema ? `\n  Schema: ${JSON.stringify(tool.inputSchema)}` : "";
  return `${tool.prefixedName}\n  Server: ${tool.server} (${tool.name})\n  ${tool.description || "(no description)"}${schema}`;
}

function noToolsMessage(manager: McpManager): string {
  const servers = manager.listServers();
  if (servers.length === 0) {
    return "No MCP servers are configured. Add servers to .mcp.json or ~/.pi/agent/mcp.json.";
  }
  const problems = manager.discoveryProblems();
  const detail = problems.length > 0 ? `\n${problems.join("\n")}` : "";
  return `No MCP tools available.${detail}\nRun mcp({ action: "status" }) or /mcp for details.`;
}

export function registerMcpTool(
  pi: ExtensionAPI,
  manager: McpManager,
  onStatusChange?: (ctx: ExtensionContext) => void,
): void {
  pi.registerTool({
    name: "mcp",
    label: "MCP",
    description:
      "Discover and call MCP server tools without loading every tool schema into context. Search or list tools, describe one, then call it. Use auth when a server reports it needs OAuth.",
    promptSnippet: "Discover and call MCP tools on demand through a single proxy",
    promptGuidelines: [
      "Use mcp to search/list/describe/call MCP tools instead of assuming a dedicated tool exists for each MCP action.",
      "Call mcp with action=search or action=list before action=call so you use the prefixed tool name.",
      "If mcp reports OAuth is required, call mcp with action=auth for that server before retrying.",
    ],
    parameters: McpParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      try {
        switch (params.action) {
          case "status":
            return toolText(manager.formatStatus(), { action: "status", servers: manager.listServers() });

          case "list": {
            onUpdate?.(toolText("Listing MCP tools..."));
            await manager.ensureAllTools(signal);
            const tools = manager.allCachedTools();
            if (tools.length === 0) return toolText(noToolsMessage(manager), { action: "list", tools: [] });
            const shown = tools.slice(0, MAX_LIST_TOOLS);
            const overflow =
              tools.length > shown.length
                ? `\n\n(${tools.length - shown.length} more; use action=search to narrow.)`
                : "";
            return toolText(`${shown.map((t) => `${t.prefixedName} — ${t.description}`).join("\n")}${overflow}`, {
              action: "list",
              tools: shown,
              total: tools.length,
            });
          }

          case "search": {
            const query = params.query?.trim();
            if (!query) toolFailure("query is required for search.", "MCP_BAD_ARGS");
            onUpdate?.(toolText(`Searching MCP tools for "${query}"...`));
            await manager.ensureAllTools(signal);
            const matches = manager.searchTools(query);
            if (matches.length === 0) {
              const total = manager.allCachedTools().length;
              return toolText(
                total === 0
                  ? noToolsMessage(manager)
                  : `No MCP tools matched "${query}" out of ${total} available. Try action=list.`,
                { action: "search", matches: [] },
              );
            }
            const shown = matches.slice(0, MAX_SEARCH_MATCHES);
            const overflow = matches.length > shown.length ? `\n\n(${matches.length - shown.length} more matches.)` : "";
            return toolText(`${shown.map(formatTool).join("\n\n")}${overflow}`, {
              action: "search",
              matches: shown,
              total: matches.length,
            });
          }

          case "describe": {
            const name = params.tool?.trim();
            if (!name) toolFailure("tool is required for describe.", "MCP_BAD_ARGS");
            await manager.ensureAllTools(signal);
            const tool = manager.findTool(name);
            if (!tool) {
              const near = manager.searchTools(name).slice(0, 5);
              const hint = near.length > 0 ? ` Did you mean: ${near.map((t) => t.prefixedName).join(", ")}?` : "";
              toolFailure(`Unknown MCP tool "${name}".${hint}`, "MCP_UNKNOWN_TOOL");
            }
            return toolText(formatTool(tool), { action: "describe", tool });
          }

          case "call": {
            const name = params.tool?.trim();
            if (!name) toolFailure("tool is required for call.", "MCP_BAD_ARGS");
            onUpdate?.(toolText(`Calling MCP tool ${name}...`));
            if (!manager.findTool(name)) await manager.ensureAllTools(signal);
            const text = await manager.callTool(name, params.args, signal);
            return toolText(text, { action: "call", tool: name });
          }

          case "auth": {
            const server = params.server?.trim();
            if (!server) toolFailure("server is required for auth.", "MCP_BAD_ARGS");
            onUpdate?.(toolText(`Starting OAuth for ${server}...`));
            const text = await manager.auth(server, params.redirectUrl, signal);
            return toolText(text, { action: "auth", server });
          }

          case "disconnect": {
            const server = params.server?.trim() || undefined;
            await manager.disconnect(server);
            return toolText(server ? `Disconnected ${server}.` : "Disconnected all MCP servers.", {
              action: "disconnect",
              server,
            });
          }

          default:
            toolFailure(`Unknown action: ${String(params.action)}`, "MCP_BAD_ARGS");
        }
      } catch (error) {
        const message = error instanceof PiEssentialsError ? error.message : errorMessage(error);
        toolFailure(`${params.action}: ${message}`, error instanceof PiEssentialsError ? error.code : "MCP_ERROR");
      } finally {
        onStatusChange?.(ctx);
      }
    },
    renderCall: renderMcpCall,
    renderResult: renderMcpResult,
  });
}
