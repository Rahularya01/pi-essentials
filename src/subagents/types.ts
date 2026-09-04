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

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Agent names appear in CLI-visible text and file names, so keep them boring. */
function sanitizeName(raw: string): string {
  return raw
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/[.-]{2,}/g, "-")
    .replace(/^[.\-]+|[.\-]+$/g, "")
    .slice(0, 64);
}

function toStringList(value: unknown): string[] | undefined {
  const items =
    typeof value === "string"
      ? value.split(",")
      : Array.isArray(value)
        ? value.map((item) => String(item))
        : undefined;
  if (!items) return undefined;
  const cleaned = items.map((item) => item.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}

export function parseAgentMarkdown(
  markdown: string,
  fallbackName: string,
  source: AgentDefinition["source"],
  filePath?: string,
): AgentDefinition {
  const match = markdown.match(FRONTMATTER);
  const body = match ? markdown.slice(match[0].length) : markdown;
  const fm = match ? parseFrontmatter(match[1]) : {};
  const name = sanitizeName(String(fm.name ?? fallbackName)) || sanitizeName(fallbackName);
  return {
    name,
    description: String(fm.description ?? "").trim(),
    tools: toStringList(fm.tools),
    model: typeof fm.model === "string" && fm.model.trim() ? fm.model.trim() : undefined,
    systemPrompt: body.trim(),
    source,
    filePath,
  };
}

/** Minimal YAML subset: `key: value`, inline `[a, b]` lists, and `- item` block lists. */
function parseFrontmatter(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = raw.split(/\r?\n/);
  let listKey: string | undefined;

  for (const line of lines) {
    const blockItem = /^\s*-\s+(.*)$/.exec(line);
    if (blockItem && listKey) {
      const items = (out[listKey] as string[]) ?? [];
      const value = unquote(blockItem[1].trim());
      if (value) items.push(value);
      out[listKey] = items;
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = unquote(trimmed.slice(idx + 1).trim());

    if (!value) {
      listKey = key;
      out[key] = [];
      continue;
    }
    listKey = undefined;
    if (value.startsWith("[") && value.endsWith("]")) {
      out[key] = value
        .slice(1, -1)
        .split(",")
        .map((item) => unquote(item.trim()))
        .filter(Boolean);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

export function validateSubagentParams(params: {
  agent?: string;
  task?: string;
  tasks?: Array<{ agent: string; task: string }>;
  chain?: Array<{ agent: string; task: string }>;
}): { mode: "single" | "parallel" | "chain" } | { error: string } {
  const hasChain = (params.chain?.length ?? 0) > 0;
  const hasTasks = (params.tasks?.length ?? 0) > 0;
  const hasSingle = Boolean(params.agent?.trim() && params.task?.trim());
  const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
  if (modeCount === 0) {
    const partial = params.agent || params.task;
    return {
      error: partial
        ? "Single mode needs both { agent, task }. Otherwise pass { tasks: [...] } or { chain: [...] }."
        : "Provide exactly one mode: { agent, task }, { tasks: [...] }, or { chain: [...] }.",
    };
  }
  if (modeCount > 1) {
    return { error: "Provide exactly one mode: { agent, task }, { tasks: [...] }, or { chain: [...] }." };
  }
  if (hasSingle) return { mode: "single" };
  if (hasTasks) return { mode: "parallel" };
  return { mode: "chain" };
}
