import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, getProjectPiDir } from "../paths.ts";
import { parseAgentMarkdown, type AgentDefinition, type AgentScope } from "./types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

function loadDir(dir: string, source: AgentDefinition["source"]): AgentDefinition[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: AgentDefinition[] = [];
  for (const entry of entries.sort()) {
    if (!entry.toLowerCase().endsWith(".md")) continue;
    const filePath = path.join(dir, entry);
    try {
      if (!fs.statSync(filePath).isFile()) continue;
      const markdown = fs.readFileSync(filePath, "utf8");
      const agent = parseAgentMarkdown(markdown, path.basename(entry, path.extname(entry)), source, filePath);
      if (agent.name) out.push(agent);
    } catch {
      // Skip unreadable or malformed agent files rather than failing discovery.
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
  const width = Math.max(...agents.map((a) => a.name.length));
  return agents
    .map((a) => `${a.name.padEnd(width)}  [${a.source}] ${a.description || "(no description)"}`)
    .join("\n");
}
