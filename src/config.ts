import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_MCP_IDLE_TIMEOUT_MS,
  DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  DEFAULT_SEARCH_RESULTS,
  DEFAULT_SUBAGENT_CONCURRENCY,
  DEFAULT_SUBAGENT_OUTPUT_BYTES,
  DEFAULT_SUBAGENT_SPAWN_BUDGET,
  DEFAULT_WEB_MAX_BYTES,
  DEFAULT_WEB_MAX_CHARS,
  DEFAULT_WEB_TIMEOUT_MS,
  MAX_PARALLEL_SUBAGENTS,
} from "./security/limits.ts";
import { getProjectConfigPath, getUserConfigPath } from "./paths.ts";
import { normalizeAllowedHost } from "./security/ssrf.ts";

export type FeatureToggle = boolean | { enabled?: boolean };

export type SearchProviderName = "auto" | "duckduckgo" | "brave" | "tavily" | "exa" | "jina" | "searxng";

export interface McpFeatureConfig {
  enabled?: boolean;
  requestTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export interface WebSearchConfig {
  provider?: SearchProviderName;
  braveApiKey?: string;
  tavilyApiKey?: string;
  exaApiKey?: string;
  jinaApiKey?: string;
  searxngUrl?: string;
  timeoutMs?: number;
  maxResults?: number;
}

export interface WebFetchConfig {
  timeoutMs?: number;
  maxBytes?: number;
  maxChars?: number;
  jinaFallback?: boolean;
}

export interface WebFeatureConfig {
  enabled?: boolean;
  search?: WebSearchConfig;
  fetch?: WebFetchConfig;
  /**
   * Private hosts the user deliberately trusts, as `host` or `host:port`.
   * Needed for self-hosted services such as a local SearXNG instance, which the
   * private-address guard would otherwise block.
   */
  allowedHosts?: string[];
}

export interface SubagentsFeatureConfig {
  enabled?: boolean;
  maxConcurrency?: number;
  maxParallel?: number;
  maxOutputBytes?: number;
  spawnBudget?: number;
  allowNested?: boolean;
}

export interface PiEssentialsFile {
  mcp?: boolean | McpFeatureConfig;
  web?: boolean | WebFeatureConfig;
  subagents?: boolean | SubagentsFeatureConfig;
  todos?: boolean | { enabled?: boolean };
  questions?: boolean | { enabled?: boolean };
}

export interface ResolvedMcpConfig {
  enabled: boolean;
  requestTimeoutMs: number;
  idleTimeoutMs: number;
}

export interface ResolvedWebConfig {
  enabled: boolean;
  allowedHosts: ReadonlySet<string>;
  search: {
    provider: SearchProviderName;
    braveApiKey?: string;
    tavilyApiKey?: string;
    exaApiKey?: string;
    jinaApiKey?: string;
    searxngUrl?: string;
    timeoutMs: number;
    maxResults: number;
  };
  fetch: {
    timeoutMs: number;
    maxBytes: number;
    maxChars: number;
    jinaFallback: boolean;
  };
}

export interface ResolvedSubagentsConfig {
  enabled: boolean;
  maxConcurrency: number;
  maxParallel: number;
  maxOutputBytes: number;
  spawnBudget: number;
  allowNested: boolean;
}

export interface ResolvedConfig {
  mcp: ResolvedMcpConfig;
  web: ResolvedWebConfig;
  subagents: ResolvedSubagentsConfig;
  todos: { enabled: boolean };
  questions: { enabled: boolean };
  warnings: string[];
}

const DEFAULTS: PiEssentialsFile = {
  mcp: true,
  web: true,
  subagents: true,
  todos: true,
  questions: true,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function enabledFrom(flag: unknown, fallback: boolean): boolean {
  if (typeof flag === "boolean") return flag;
  if (isObject(flag) && typeof flag.enabled === "boolean") return flag.enabled;
  return fallback;
}

function positiveInt(value: unknown, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readJsonFile(filePath: string, warnings: string[]): unknown {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    warnings.push(`Ignoring malformed config at ${filePath}; using defaults for that file.`);
    return undefined;
  }
}

function asFile(value: unknown, filePath: string, warnings: string[]): PiEssentialsFile {
  if (value === undefined) return {};
  if (!isObject(value)) {
    warnings.push(`Ignoring ${filePath}: expected a JSON object at the top level.`);
    return {};
  }
  const known = new Set<string>(FEATURE_KEYS);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      warnings.push(`Unknown option "${key}" in ${filePath}; expected one of ${[...known].join(", ")}.`);
    }
  }
  return value as PiEssentialsFile;
}

const FEATURE_KEYS = ["mcp", "web", "subagents", "todos", "questions"] as const;

/** Layer one config file over another; later files win, objects merge key by key. */
export function mergeFiles(base: PiEssentialsFile, overlay: PiEssentialsFile): PiEssentialsFile {
  const merged: PiEssentialsFile = { ...base };
  for (const key of FEATURE_KEYS) {
    const next = overlay[key];
    if (next === undefined) continue;
    (merged as Record<string, unknown>)[key] = mergeMaybeObject(base[key], next);
  }
  return merged;
}

function mergeMaybeObject<T>(base: boolean | T | undefined, overlay: boolean | T): boolean | T {
  if (typeof overlay === "boolean" || typeof base === "boolean" || base === undefined) return overlay;
  if (isObject(base) && isObject(overlay)) return deepMerge(base, overlay) as T;
  return overlay;
}

function deepMerge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = out[key];
    out[key] = isObject(existing) && isObject(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

function envOr(configValue: string | undefined, envName: string): string | undefined {
  return configValue || optionalString(process.env[envName]);
}

/**
 * Build the private-host allowlist. A configured SearXNG instance is trusted
 * implicitly: pointing `searxngUrl` at localhost is the normal way to run one,
 * and silently blocking it would make the setting useless.
 */
function resolveAllowedHosts(
  configured: unknown,
  searxngUrl: string | undefined,
  warnings: string[],
): ReadonlySet<string> {
  const hosts = new Set<string>();
  const add = (entry: string, source: string) => {
    const normalized = normalizeAllowedHost(entry);
    if (normalized) hosts.add(normalized);
    else warnings.push(`Ignoring unparseable ${source} entry "${entry}".`);
  };

  if (configured !== undefined) {
    if (Array.isArray(configured)) {
      for (const entry of configured) {
        if (typeof entry === "string") add(entry, "web.allowedHosts");
        else warnings.push("web.allowedHosts entries must be strings.");
      }
    } else {
      warnings.push("web.allowedHosts must be an array of host or host:port strings.");
    }
  }
  if (searxngUrl) add(searxngUrl, "web.search.searxngUrl");
  return hosts;
}

export function resolveConfig(file: PiEssentialsFile, warnings: string[] = []): ResolvedConfig {
  const mcpIn = file.mcp ?? true;
  const webIn = file.web ?? true;
  const subIn = file.subagents ?? true;
  const mcpObj = isObject(mcpIn) ? mcpIn : {};
  const webObj = isObject(webIn) ? webIn : {};
  const subObj = isObject(subIn) ? subIn : {};
  const search = isObject(webObj.search) ? webObj.search : {};
  const fetch = isObject(webObj.fetch) ? webObj.fetch : {};

  const searxngUrl = optionalString(search.searxngUrl) ?? optionalString(process.env.SEARXNG_URL);
  const providerRaw = optionalString(search.provider) ?? "auto";
  const providers: SearchProviderName[] = ["auto", "duckduckgo", "brave", "tavily", "exa", "jina", "searxng"];
  const provider = (providers.includes(providerRaw as SearchProviderName) ? providerRaw : "auto") as SearchProviderName;
  if (providerRaw !== provider) {
    warnings.push(`Unknown search provider "${providerRaw}"; using auto.`);
  }

  return {
    mcp: {
      enabled: enabledFrom(mcpIn, true),
      requestTimeoutMs: positiveInt(mcpObj.requestTimeoutMs, DEFAULT_MCP_REQUEST_TIMEOUT_MS, 1000, 300_000),
      idleTimeoutMs: positiveInt(mcpObj.idleTimeoutMs, DEFAULT_MCP_IDLE_TIMEOUT_MS, 1000, 24 * 60 * 60_000),
    },
    web: {
      enabled: enabledFrom(webIn, true),
      allowedHosts: resolveAllowedHosts(webObj.allowedHosts, searxngUrl, warnings),
      search: {
        provider,
        braveApiKey: envOr(optionalString(search.braveApiKey), "BRAVE_API_KEY"),
        tavilyApiKey: envOr(optionalString(search.tavilyApiKey), "TAVILY_API_KEY"),
        exaApiKey: envOr(optionalString(search.exaApiKey), "EXA_API_KEY"),
        jinaApiKey: envOr(optionalString(search.jinaApiKey), "JINA_API_KEY"),
        searxngUrl,
        timeoutMs: positiveInt(search.timeoutMs, DEFAULT_WEB_TIMEOUT_MS, 1000, 60_000),
        maxResults: positiveInt(search.maxResults, DEFAULT_SEARCH_RESULTS, 1, 20),
      },
      fetch: {
        timeoutMs: positiveInt(fetch.timeoutMs, DEFAULT_WEB_TIMEOUT_MS, 1000, 60_000),
        maxBytes: positiveInt(fetch.maxBytes, DEFAULT_WEB_MAX_BYTES, 16_384, 8 * 1024 * 1024),
        maxChars: positiveInt(fetch.maxChars, DEFAULT_WEB_MAX_CHARS, 1000, 200_000),
        jinaFallback: fetch.jinaFallback !== false,
      },
    },
    subagents: {
      enabled: enabledFrom(subIn, true),
      maxConcurrency: positiveInt(subObj.maxConcurrency, DEFAULT_SUBAGENT_CONCURRENCY, 1, MAX_PARALLEL_SUBAGENTS),
      maxParallel: positiveInt(subObj.maxParallel, MAX_PARALLEL_SUBAGENTS, 1, MAX_PARALLEL_SUBAGENTS),
      maxOutputBytes: positiveInt(subObj.maxOutputBytes, DEFAULT_SUBAGENT_OUTPUT_BYTES, 1024, 1024 * 1024),
      spawnBudget: positiveInt(subObj.spawnBudget, DEFAULT_SUBAGENT_SPAWN_BUDGET, 1, 64),
      allowNested: subObj.allowNested === true,
    },
    todos: { enabled: enabledFrom(file.todos ?? true, true) },
    questions: { enabled: enabledFrom(file.questions ?? true, true) },
    warnings,
  };
}

export function loadConfig(cwd: string = process.cwd()): ResolvedConfig {
  const warnings: string[] = [];
  const userRaw = readJsonFile(getUserConfigPath(), warnings);
  const projectRaw = readJsonFile(getProjectConfigPath(cwd), warnings);
  const merged = mergeFiles(
    mergeFiles(DEFAULTS, asFile(userRaw, getUserConfigPath(), warnings)),
    asFile(projectRaw, getProjectConfigPath(cwd), warnings),
  );
  return resolveConfig(merged, warnings);
}

export function warnConfig(warnings: string[], notify?: (message: string) => void): void {
  for (const warning of warnings) {
    if (notify) notify(warning);
    else console.warn(`[pi-essentials] ${warning}`);
  }
}

export function ensureDir(dir: string, mode = 0o700): void {
  fs.mkdirSync(dir, { recursive: true, mode });
  try {
    fs.chmodSync(dir, mode);
  } catch {
    // Best-effort on platforms that ignore chmod.
  }
}

let tmpCounter = 0;

export function writePrivateFile(filePath: string, contents: string): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${tmpCounter++}.tmp`;
  try {
    fs.writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best-effort cleanup of the partial temp file.
    }
    throw error;
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best-effort.
  }
}
