import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../errors.ts";
import type { McpManager } from "./manager.ts";

const USAGE = "Usage: /mcp [status|tools|reconnect [name]|auth <name>|disconnect [name]]";

export function registerMcpCommands(
  pi: ExtensionAPI,
  manager: McpManager,
  onStatusChange?: (ctx: ExtensionContext) => void,
): void {
  pi.registerCommand("mcp", {
    description: "Show MCP server status, list tools, reconnect, or start OAuth. Usage: /mcp [reconnect [name]|auth <name>]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase();
      try {
        switch (sub) {
          case undefined:
          case "status":
            ctx.ui.notify(manager.formatStatus(), "info");
            return;

          case "tools": {
            ctx.ui.notify("Connecting to MCP servers…", "info");
            await manager.ensureAllTools();
            const tools = manager.allCachedTools();
            ctx.ui.notify(
              tools.length === 0
                ? "No MCP tools available. Check /mcp status."
                : tools.map((t) => `${t.prefixedName} — ${t.description || "(no description)"}`).join("\n"),
              "info",
            );
            return;
          }

          case "reconnect": {
            const name = parts[1];
            if (name) {
              await manager.connect(name, undefined, true);
              ctx.ui.notify(`Reconnected ${name}`, "info");
            } else {
              await manager.refreshAll();
              ctx.ui.notify(`Reconnected MCP servers\n\n${manager.formatStatus()}`, "info");
            }
            return;
          }

          case "auth": {
            const name = parts[1];
            if (!name) {
              ctx.ui.notify("Usage: /mcp auth <server>", "warning");
              return;
            }
            ctx.ui.notify(await manager.auth(name), "info");
            return;
          }

          case "disconnect":
            await manager.disconnect(parts[1]);
            ctx.ui.notify(parts[1] ? `Disconnected ${parts[1]}` : "Disconnected all MCP servers", "info");
            return;

          default:
            ctx.ui.notify(USAGE, "warning");
        }
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      } finally {
        onStatusChange?.(ctx);
      }
    },
  });
}
