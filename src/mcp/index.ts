import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "../config.ts";
import { registerMcpCommands } from "./commands.ts";
import { McpManager } from "./manager.ts";
import { registerMcpTool } from "./proxy-tool.ts";
import { mcpStatusText } from "./render.ts";

/** How often the footer status re-reads server state while a session is open. */
const STATUS_POLL_MS = 4000;

export function registerMcp(pi: ExtensionAPI, config: ResolvedConfig): void {
  const manager = new McpManager(process.cwd(), config);
  let statusTimer: NodeJS.Timeout | undefined;
  let lastStatus: string | undefined;

  const refreshStatus = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const text = mcpStatusText(manager.listServers());
    if (text === lastStatus) return;
    lastStatus = text;
    ctx.ui.setStatus("pi-essentials-mcp", text);
  };

  registerMcpTool(pi, manager, refreshStatus);
  registerMcpCommands(pi, manager, refreshStatus);

  let warned = false;
  pi.on("session_start", async (_event, ctx) => {
    manager.reset();
    if (!warned && manager.warnings.length > 0) {
      warned = true;
      for (const warning of manager.warnings) {
        if (ctx.hasUI) ctx.ui.notify(`pi-essentials: ${warning}`, "warning");
        else console.warn(`[pi-essentials] ${warning}`);
      }
    }
    // Only eager/keep-alive servers connect here; lazy servers wait for first use.
    await manager.ensureMetadata().catch(() => undefined);
    refreshStatus(ctx);

    // Idle disconnects and OAuth expiry change status without a tool call, so
    // the footer polls rather than relying only on explicit refreshes.
    if (ctx.hasUI && !statusTimer) {
      statusTimer = setInterval(() => refreshStatus(ctx), STATUS_POLL_MS);
      statusTimer.unref?.();
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = undefined;
    if (ctx.hasUI) ctx.ui.setStatus("pi-essentials-mcp", undefined);
    await manager.shutdown().catch(() => undefined);
  });
}
