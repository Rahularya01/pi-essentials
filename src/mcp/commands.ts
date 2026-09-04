import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { McpManager } from "./manager.ts";

export function registerMcpCommands(pi: ExtensionAPI, manager: McpManager): void {
  pi.registerCommand("mcp", {
    description: "Show MCP server status, reconnect, or start OAuth. Usage: /mcp [reconnect [name]|auth <name>]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase();
      try {
        if (!sub) {
          ctx.ui.notify(manager.formatStatus(), "info");
          return;
        }
        if (sub === "reconnect") {
          const name = parts[1];
          if (name) {
            await manager.connect(name, undefined, true);
            ctx.ui.notify(`Reconnected ${name}`, "info");
          } else {
            await manager.refreshAll();
            ctx.ui.notify("Reconnected MCP servers", "info");
          }
          return;
        }
        if (sub === "auth") {
          const name = parts[1];
          if (!name) {
            ctx.ui.notify("Usage: /mcp auth <server>", "warning");
            return;
          }
          const message = await manager.auth(name);
          ctx.ui.notify(message, "info");
          return;
        }
        ctx.ui.notify("Usage: /mcp [reconnect [name]|auth <name>]", "warning");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
