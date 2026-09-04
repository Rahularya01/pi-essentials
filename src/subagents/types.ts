export interface AgentDefinition {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "builtin" | "user" | "project";
  filePath?: string;
}

export type AgentScope = "user" | "project" | "both";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseAgentMarkdown(markdown: string, fallbackName: string, source: AgentDefinition["source"], filePath?: string): AgentDefinition {
  const match = markdown.match(FRONTMATTER);
  const body = match ? markdown.slice(match[0].length) : markdown;
  const fm = match ? parseFrontmatter(match[1]) : {};
  const name = String(fm.name ?? fallbackName).trim();
  const toolsRaw = fm.tools;
  const tools =
    typeof toolsRaw === "string"
      ? toolsRaw
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : Array.isArray(toolsRaw)
        ? toolsRaw.map((t) => String(t).trim()).filter(Boolean)
        : undefined;
  return {
    name,
    description: String(fm.description ?? "").trim(),
    tools,
    model: typeof fm.model === "string" && fm.model.trim() ? fm.model.trim() : undefined,
    systemPrompt: body.trim(),
    source,
    filePath,
  };
}

function parseFrontmatter(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      out[key] = value
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function validateSubagentParams(params: {
  agent?: string;
  task?: string;
  tasks?: Array<{ agent: string; task: string }>;
  chain?: Array<{ agent: string; task: string }>;
}): { mode: "single" | "parallel" | "chain" } | { error: string } {
  const hasChain = (params.chain?.length ?? 0) > 0;
  const hasTasks = (params.tasks?.length ?? 0) > 0;
  const hasSingle = Boolean(params.agent && params.task);
  const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
  if (modeCount !== 1) {
    return { error: 'Provide exactly one mode: { agent, task }, { tasks: [...] }, or { chain: [...] }.' };
  }
  if (hasSingle) return { mode: "single" };
  if (hasTasks) return { mode: "parallel" };
  return { mode: "chain" };
}
