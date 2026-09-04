import fs from "node:fs";
import type { McpFileShape, McpServerDefinition, ResolvedServer } from "./types.ts";
import { mcpConfigCandidates } from "../paths.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asServer(value: unknown): McpServerDefinition | undefined {
  if (!isObject(value)) return undefined;
  const command = typeof value.command === "string" ? value.command : undefined;
  const url = typeof value.url === "string" ? value.url : undefined;
  if (!command && !url) return undefined;
  return value as McpServerDefinition;
}

function readFile(filePath: string): McpFileShape {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!isObject(parsed)) return {};
    return parsed as McpFileShape;
  } catch {
    console.warn(`[pi-essentials] Ignoring malformed MCP config at ${filePath}`);
    return {};
  }
}

export function loadMcpServers(cwd: string): { servers: ResolvedServer[]; warnings: string[] } {
  const warnings: string[] = [];
  const byName = new Map<string, ResolvedServer>();
  for (const filePath of mcpConfigCandidates(cwd)) {
    const file = readFile(filePath);
    const entries = file.mcpServers ?? {};
    for (const [name, raw] of Object.entries(entries)) {
      const definition = asServer(raw);
      if (!definition) {
        warnings.push(`Skipping invalid MCP server "${name}" in ${filePath}`);
        continue;
      }
      byName.set(name, { name, definition, source: filePath });
    }
  }
  return { servers: [...byName.values()], warnings };
}

export function serverTransport(def: McpServerDefinition): "stdio" | "http" | "unknown" {
  if (def.command) return "stdio";
  if (def.url) return "http";
  return "unknown";
}
