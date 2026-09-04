import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "../config.ts";
import { registerMcpCommands } from "./commands.ts";
import { McpManager } from "./manager.ts";
import { registerMcpTool } from "./proxy-tool.ts";

export function registerMcp(pi: ExtensionAPI, config: ResolvedConfig): void {
  const manager = new McpManager(process.cwd(), config);

  registerMcpTool(pi, manager);
  registerMcpCommands(pi, manager);

  pi.on("session_start", async () => {
    await manager.ensureMetadata().catch(() => undefined);
  });

  pi.on("session_shutdown", async () => {
    await manager.shutdown();
  });
}
