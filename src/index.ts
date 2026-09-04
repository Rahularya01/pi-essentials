import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, warnConfig } from "./config.ts";
import { registerMcp } from "./mcp/index.ts";
import { registerQuestions } from "./questions/index.ts";
import { registerSubagents } from "./subagents/index.ts";
import { registerTodos } from "./todos/index.ts";
import { registerWeb } from "./web/index.ts";

export type { PiEssentialsFile, ResolvedConfig } from "./config.ts";
export { loadConfig, resolveConfig } from "./config.ts";

/** Depth beyond which a subagent may no longer spawn further subagents. */
export const MAX_NEST_DEPTH = 2;

export function readNestDepth(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.PI_ESSENTIALS_NEST_DEPTH ?? "0", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export default function piEssentials(pi: ExtensionAPI): void {
  const config = loadConfig(process.cwd());

  const nested = process.env.PI_ESSENTIALS_SUBAGENT === "1";
  const nestDepth = readNestDepth();

  // Surface config problems through the UI once a session exists; writing to the
  // console during extension load corrupts TUI rendering.
  let warned = false;
  pi.on("session_start", async (_event, ctx) => {
    if (warned || config.warnings.length === 0) return;
    warned = true;
    if (ctx.hasUI) warnConfig(config.warnings, (message) => ctx.ui.notify(`pi-essentials: ${message}`, "warning"));
    else warnConfig(config.warnings);
  });

  if (config.mcp.enabled && !nested) registerMcp(pi, config);
  if (config.web.enabled) registerWeb(pi, config);
  if (config.subagents.enabled && (!nested || (config.subagents.allowNested && nestDepth < MAX_NEST_DEPTH))) {
    registerSubagents(pi, config);
  }
  if (config.todos.enabled && !nested) registerTodos(pi);
  if (config.questions.enabled && !nested) registerQuestions(pi);
}
