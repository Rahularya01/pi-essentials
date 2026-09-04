import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { errorMessage, PiEssentialsError, toolError, toolText } from "../errors.ts";
import type { McpManager } from "./manager.ts";

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

function formatTool(tool: { prefixedName: string; name: string; server: string; description: string; inputSchema?: unknown }): string {
  const schema = tool.inputSchema ? `\n  Schema: ${JSON.stringify(tool.inputSchema)}` : "";
  return `${tool.prefixedName}\n  Server: ${tool.server} (${tool.name})\n  ${tool.description || "(no description)"}${schema}`;
}

export function registerMcpTool(pi: ExtensionAPI, manager: McpManager): void {
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
    async execute(_toolCallId, params, signal, onUpdate) {
      try {
        switch (params.action) {
          case "status":
            return toolText(manager.formatStatus(), { action: "status", servers: manager.listServers() });
          case "list": {
            onUpdate?.(toolText("Connecting to MCP servers to refresh tool lists..."));
            await manager.ensureMetadata(signal);
            const unnamed = manager.allCachedTools();
            if (unnamed.length === 0) {
              await manager.refreshAll(signal);
            }
            const tools = manager.allCachedTools();
            if (tools.length === 0) return toolText("No MCP tools available. Check /mcp status and server configuration.");
            return toolText(tools.map((t) => `${t.prefixedName} — ${t.description}`).join("\n"), {
              action: "list",
              tools,
            });
          }
          case "search": {
            if (!params.query?.trim()) return toolError("query is required for search");
            onUpdate?.(toolText(`Searching MCP tools for "${params.query}"...`));
            if (manager.allCachedTools().length === 0) await manager.refreshAll(signal);
            const matches = manager.searchTools(params.query);
            if (matches.length === 0) {
              return toolText(`No MCP tools matched "${params.query}". Try action=list.`);
            }
            return toolText(matches.slice(0, 20).map(formatTool).join("\n\n"), { action: "search", matches });
          }
          case "describe": {
            if (!params.tool) return toolError("tool is required for describe");
            if (manager.allCachedTools().length === 0) await manager.refreshAll(signal);
            const tool = manager.findTool(params.tool);
            if (!tool) return toolError(`Unknown MCP tool "${params.tool}"`);
            return toolText(formatTool(tool), { action: "describe", tool });
          }
          case "call": {
            if (!params.tool) return toolError("tool is required for call");
            onUpdate?.(toolText(`Calling MCP tool ${params.tool}...`));
            if (manager.allCachedTools().length === 0) {
              await manager.refreshAll(signal);
            }
            const text = await manager.callTool(params.tool, params.args, signal);
            return toolText(text, { action: "call", tool: params.tool });
          }
          case "auth": {
            if (!params.server) return toolError("server is required for auth");
            onUpdate?.(toolText(`Starting OAuth for ${params.server}...`));
            const text = await manager.auth(params.server, params.redirectUrl, signal);
            return toolText(text, { action: "auth", server: params.server });
          }
          case "disconnect": {
            await manager.disconnect(params.server);
            return toolText(params.server ? `Disconnected ${params.server}.` : "Disconnected all MCP servers.", {
              action: "disconnect",
              server: params.server,
            });
          }
          default:
            return toolError(`Unknown action: ${String(params.action)}`);
        }
      } catch (error) {
        const message = error instanceof PiEssentialsError ? error.message : errorMessage(error);
        return toolError(message, { action: params.action });
      }
    },
  });
}
