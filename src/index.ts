import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, warnConfig } from "./config.ts";
import { registerMcp } from "./mcp/index.ts";
import { registerQuestions } from "./questions/index.ts";
import { registerSubagents } from "./subagents/index.ts";
import { registerTodos } from "./todos/index.ts";
import { registerWeb } from "./web/index.ts";

export type { PiEssentialsFile, ResolvedConfig } from "./config.ts";
export { loadConfig, resolveConfig } from "./config.ts";

export default function piEssentials(pi: ExtensionAPI): void {
  const config = loadConfig(process.cwd());
  warnConfig(config.warnings);

  const nested = process.env.PI_ESSENTIALS_SUBAGENT === "1";
  const nestDepth = Number(process.env.PI_ESSENTIALS_NEST_DEPTH ?? "0");

  if (config.mcp.enabled && !nested) registerMcp(pi, config);
  if (config.web.enabled) registerWeb(pi, config);
  if (config.subagents.enabled && (!nested || (config.subagents.allowNested && nestDepth < 2))) {
    registerSubagents(pi, config);
  }
  if (config.todos.enabled && !nested) registerTodos(pi);
  if (config.questions.enabled && !nested) registerQuestions(pi);
}
