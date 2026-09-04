import fs from "node:fs";
import type { McpFileShape, McpServerDefinition, ResolvedServer } from "./types.ts";
import { mcpConfigCandidates } from "../paths.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function stringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((item) => typeof item === "string");
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function asServer(value: unknown): { definition?: McpServerDefinition; problem?: string } {
  if (!isObject(value)) return { problem: "entry is not an object" };
  const command = typeof value.command === "string" && value.command.trim() ? value.command : undefined;
  const url = typeof value.url === "string" && value.url.trim() ? value.url : undefined;
  if (!command && !url) return { problem: 'entry needs either "command" (stdio) or "url" (http)' };
  if (command && url) return { problem: 'entry sets both "command" and "url"; use one transport' };
  if (url) {
    try {
      if (!["http:", "https:"].includes(new URL(url).protocol)) return { problem: '"url" must use http or https' };
    } catch {
      return { problem: '"url" must be a valid http(s) URL' };
    }
  }
  for (const key of ["args", "includeTools", "excludeTools"] as const) {
    if (value[key] !== undefined && !stringArray(value[key])) return { problem: `"${key}" must be an array of strings` };
  }
  for (const key of ["env", "headers"] as const) {
    if (value[key] !== undefined && !stringRecord(value[key])) return { problem: `"${key}" must map strings to strings` };
  }
  for (const key of ["cwd", "bearerToken", "bearerTokenEnv"] as const) {
    if (!optionalString(value[key])) return { problem: `"${key}" must be a string` };
  }
  if (value.disabled !== undefined && typeof value.disabled !== "boolean") return { problem: '"disabled" must be a boolean' };
  if (value.lifecycle !== undefined && !["lazy", "eager", "keep-alive"].includes(String(value.lifecycle))) {
    return { problem: '"lifecycle" must be lazy, eager, or keep-alive' };
  }
  if (value.auth !== undefined && !["bearer", "oauth"].includes(String(value.auth))) {
    return { problem: '"auth" must be bearer or oauth' };
  }
  if (value.toolPrefix !== undefined && !["server", "none"].includes(String(value.toolPrefix))) {
    return { problem: '"toolPrefix" must be server or none' };
  }
  for (const key of ["idleTimeout", "requestTimeoutMs"] as const) {
    if (value[key] !== undefined && positiveNumber(value[key]) === undefined) {
      return { problem: `"${key}" must be a positive finite number` };
    }
  }
  if (value.oauth !== undefined) {
    if (!isObject(value.oauth)) return { problem: '"oauth" must be an object' };
    for (const key of ["clientId", "clientSecret", "scope", "redirectUri"] as const) {
      if (!optionalString(value.oauth[key])) return { problem: `"oauth.${key}" must be a string` };
    }
  }
  return { definition: value as McpServerDefinition };
}

function readFile(filePath: string, warnings: string[]): McpFileShape {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!isObject(parsed)) {
      warnings.push(`Ignoring MCP config at ${filePath}: expected a JSON object.`);
      return {};
    }
    if (parsed.mcpServers !== undefined && !isObject(parsed.mcpServers)) {
      warnings.push(`Ignoring "mcpServers" in ${filePath}: expected an object keyed by server name.`);
      return {};
    }
    return parsed as McpFileShape;
  } catch (error) {
    warnings.push(`Ignoring malformed MCP config at ${filePath}: ${(error as Error).message}`);
    return {};
  }
}

export function loadMcpServers(cwd: string): {
  servers: ResolvedServer[];
  warnings: string[];
  settings?: McpFileShape["settings"];
} {
  const warnings: string[] = [];
  const byName = new Map<string, ResolvedServer>();
  let settings: McpFileShape["settings"] | undefined;

  for (const filePath of mcpConfigCandidates(cwd)) {
    const file = readFile(filePath, warnings);
    if (isObject(file.settings)) {
      settings = {
        ...settings,
        requestTimeoutMs: positiveNumber(file.settings.requestTimeoutMs) ?? settings?.requestTimeoutMs,
        idleTimeout: positiveNumber(file.settings.idleTimeout) ?? settings?.idleTimeout,
      };
    }
    for (const [name, raw] of Object.entries(file.mcpServers ?? {})) {
      if (!name.trim()) {
        warnings.push(`Skipping MCP server with an empty name in ${filePath}`);
        continue;
      }
      const { definition, problem } = asServer(raw);
      if (!definition) {
        warnings.push(`Skipping MCP server "${name}" in ${filePath}: ${problem}`);
        continue;
      }
      // Later files intentionally override earlier ones (project beats user).
      byName.set(name, { name, definition, source: filePath });
    }
  }
  return { servers: [...byName.values()], warnings, settings };
}

export function serverTransport(def: McpServerDefinition): "stdio" | "http" | "unknown" {
  if (def.command) return "stdio";
  if (def.url) return "http";
  return "unknown";
}
