import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, getProjectPiDir } from "../paths.ts";
import { parseAgentMarkdown, type AgentDefinition, type AgentScope } from "./types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

function loadDir(dir: string, source: AgentDefinition["source"]): AgentDefinition[] {
  if (!fs.existsSync(dir)) return [];
  const out: AgentDefinition[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(dir, entry);
    try {
      const markdown = fs.readFileSync(filePath, "utf8");
      out.push(parseAgentMarkdown(markdown, path.basename(entry, ".md"), source, filePath));
    } catch {
      // skip unreadable agent files
    }
  }
  return out;
}

function loadBuiltins(): AgentDefinition[] {
  return loadDir(path.join(here, "builtins"), "builtin");
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDefinition[] {
  const byName = new Map<string, AgentDefinition>();
  for (const agent of loadBuiltins()) byName.set(agent.name, agent);
  if (scope === "user" || scope === "both") {
    for (const agent of loadDir(path.join(getAgentDir(), "agents"), "user")) byName.set(agent.name, agent);
  }
  if (scope === "project" || scope === "both") {
    for (const agent of loadDir(path.join(getProjectPiDir(cwd), "agents"), "project")) byName.set(agent.name, agent);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function formatAgentList(agents: AgentDefinition[]): string {
  if (agents.length === 0) return "none";
  return agents.map((a) => `${a.name} (${a.source}${a.description ? ` — ${a.description}` : ""})`).join("\n");
}
