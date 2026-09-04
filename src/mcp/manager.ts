import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ResolvedConfig } from "../config.ts";
import { capText, errorMessage, isAbortError, PiEssentialsError } from "../errors.ts";
import { interpolateEnvValue, interpolateRecord, timeoutSignal } from "../security/env.ts";
import { CONNECT_TIMEOUT_MS, MAX_TOOL_RESULT_CHARS } from "../security/limits.ts";
import { loadMcpServers, serverTransport } from "./config.ts";
import { FileOAuthProvider, maybeOpenUrl, startLoopbackCallback } from "./oauth.ts";
import type { CachedTool, ResolvedServer, ServerSnapshot, ServerStatus } from "./types.ts";

interface LiveConnection {
  client: Client;
  transport: Transport;
  lastUsed: number;
  idleTimer?: NodeJS.Timeout;
}

interface ServerState {
  server: ResolvedServer;
  status: ServerStatus;
  error?: string;
  tools: CachedTool[];
  live?: LiveConnection;
  connectPromise?: Promise<void>;
}

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function allowedTool(server: ResolvedServer, originalName: string, prefixedName: string): boolean {
  const def = server.definition;
  const names = [originalName, prefixedName];
  if (def.includeTools?.length) {
    const ok = def.includeTools.some((p) => names.some((n) => globMatch(p, n)));
    if (!ok) return false;
  }
  if (def.excludeTools?.length) {
    if (def.excludeTools.some((p) => names.some((n) => globMatch(p, n)))) return false;
  }
  return true;
}

function prefixName(serverName: string, toolName: string, mode: "server" | "none" | undefined): string {
  if (mode === "none") return toolName;
  const safe = serverName.replace(/[^A-Za-z0-9_]+/g, "_");
  return `${safe}_${toolName}`;
}

function envRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const anyErr = error as { status?: unknown; code?: unknown; cause?: unknown };
  if (typeof anyErr.status === "number") return anyErr.status;
  if (typeof anyErr.code === "number") return anyErr.code;
  const message = errorMessage(error);
  const match = message.match(/\b(404|405|406|415)\b/);
  return match ? Number(match[1]) : undefined;
}

function needsSseFallback(error: unknown): boolean {
  const status = httpStatus(error);
  return status === 404 || status === 405 || status === 406 || status === 415;
}

function stringifyToolResult(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { type?: unknown; text?: unknown };
    if (rec.type === "text" && typeof rec.text === "string") parts.push(rec.text);
    else {
      try {
        parts.push(JSON.stringify(item));
      } catch {
        parts.push(String(item));
      }
    }
  }
  if ((result as { isError?: boolean }).isError) {
    return parts.join("\n") || "MCP tool returned an error.";
  }
  return parts.join("\n\n") || "(empty MCP result)";
}

export class McpManager {
  private readonly states = new Map<string, ServerState>();
  private closed = false;

  constructor(
    private readonly cwd: string,
    private readonly config: ResolvedConfig,
  ) {
    const { servers, warnings } = loadMcpServers(cwd);
    for (const warning of warnings) console.warn(`[pi-essentials] ${warning}`);
    for (const server of servers) {
      this.states.set(server.name, {
        server,
        status: server.definition.disabled === true ? "disabled" : "idle",
        tools: [],
      });
    }
  }

  listServers(): ServerSnapshot[] {
    return [...this.states.values()].map((state) => ({
      name: state.server.name,
      status: state.status,
      toolCount: state.tools.length,
      disabled: state.status === "disabled",
      transport: serverTransport(state.server.definition),
      error: state.error,
      source: state.server.source,
    }));
  }

  allCachedTools(): CachedTool[] {
    return [...this.states.values()].flatMap((s) => s.tools);
  }

  findTool(name: string): CachedTool | undefined {
    const tools = this.allCachedTools();
    return tools.find((t) => t.prefixedName === name || t.name === name);
  }

  searchTools(query: string): CachedTool[] {
    const q = query.trim().toLowerCase();
    const tools = this.allCachedTools();
    if (!q) return tools;
    const scored = tools
      .map((tool) => {
        const hay = `${tool.prefixedName} ${tool.name} ${tool.description}`.toLowerCase();
        let score = 0;
        if (tool.prefixedName.toLowerCase() === q || tool.name.toLowerCase() === q) score += 100;
        if (tool.prefixedName.toLowerCase().includes(q) || tool.name.toLowerCase().includes(q)) score += 40;
        if (hay.includes(q)) score += 10;
        for (const word of q.split(/\s+/)) {
          if (word && hay.includes(word)) score += 3;
        }
        return { tool, score };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.map((row) => row.tool);
  }

  async ensureMetadata(signal?: AbortSignal): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const state of this.states.values()) {
      if (state.status === "disabled") continue;
      const lifecycle = state.server.definition.lifecycle ?? "lazy";
      if (lifecycle === "eager" || lifecycle === "keep-alive") {
        tasks.push(this.connect(state.server.name, signal).catch(() => undefined));
      }
    }
    await Promise.all(tasks);
  }

  async connect(name: string, signal?: AbortSignal, force = false): Promise<void> {
    const state = this.requireServer(name);
    if (state.status === "disabled") throw new PiEssentialsError(`MCP server "${name}" is disabled.`, "MCP_DISABLED");
    if (state.live && !force) {
      state.live.lastUsed = Date.now();
      this.scheduleIdle(state);
      return;
    }
    if (state.connectPromise && !force) return state.connectPromise;
    state.connectPromise = this.connectInternal(state, signal);
    try {
      await state.connectPromise;
    } finally {
      state.connectPromise = undefined;
    }
  }

  async disconnect(name?: string): Promise<void> {
    const targets = name ? [this.requireServer(name)] : [...this.states.values()];
    await Promise.all(targets.map((state) => this.disconnectState(state)));
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await this.disconnect();
  }

  async refreshAll(signal?: AbortSignal): Promise<void> {
    for (const state of this.states.values()) {
      if (state.status === "disabled") continue;
      try {
        await this.connect(state.server.name, signal, true);
      } catch {
        // status already recorded
      }
    }
  }

  async callTool(prefixedOrName: string, args: unknown, signal?: AbortSignal): Promise<string> {
    const tool = this.findTool(prefixedOrName);
    const name = tool?.name ?? prefixedOrName;
    const serverName = tool?.server ?? this.guessServer(prefixedOrName);
    if (!serverName) {
      throw new PiEssentialsError(
        `Unknown MCP tool "${prefixedOrName}". Use mcp({ action: "search", query: "..." }) first.`,
        "MCP_UNKNOWN_TOOL",
      );
    }
    await this.connect(serverName, signal);
    const state = this.requireServer(serverName);
    if (!state.live) throw new PiEssentialsError(`MCP server "${serverName}" is not connected.`, "MCP_NOT_CONNECTED");
    const timeoutMs = state.server.definition.requestTimeoutMs ?? this.config.mcp.requestTimeoutMs;
    const combined = timeoutSignal(timeoutMs, signal);
    try {
      const result = await state.live.client.callTool({ name, arguments: parseMcpArgs(args) }, undefined, {
        timeout: timeoutMs,
        signal: combined,
      });
      state.live.lastUsed = Date.now();
      this.scheduleIdle(state);
      const text = stringifyToolResult(result);
      return capText(text, MAX_TOOL_RESULT_CHARS).text;
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        state.status = "needs-auth";
        throw new PiEssentialsError(
          `MCP server "${serverName}" requires OAuth. Run mcp({ action: "auth", server: "${serverName}" }) or /mcp auth ${serverName}.`,
          "MCP_NEEDS_AUTH",
        );
      }
      throw this.wrapCallError(serverName, error);
    }
  }

  async auth(name: string, redirectUrl?: string, signal?: AbortSignal): Promise<string> {
    const state = this.requireServer(name);
    if (!state.server.definition.url) {
      throw new PiEssentialsError(`Server "${name}" is stdio and does not use OAuth.`, "MCP_NO_OAUTH");
    }
    await this.disconnectState(state);

    if (redirectUrl) {
      return this.finishExistingAuth(state, redirectUrl, signal);
    }

    const loopback = await startLoopbackCallback();
    try {
      const provider = this.createOAuthProvider(state, loopback.redirectUri);
      await this.connectWithProvider(state, provider, signal, true);
      const authorize = provider.takeRedirectUrl();
      if (!authorize && state.live) {
        return `Connected to "${name}" (existing credentials worked).`;
      }
      if (!authorize) {
        throw new PiEssentialsError(`OAuth did not produce an authorization URL for "${name}".`, "MCP_OAUTH_FAILED");
      }
      const opened = await maybeOpenUrl(authorize.toString());
      const callback = await loopback.waitForCallback(5 * 60_000);
      await this.finishAuthOnProvider(state, provider, callback, signal);
      return opened
        ? `Authenticated with "${name}".`
        : `Authenticated with "${name}". Authorization URL was: ${authorize.toString()}`;
    } finally {
      loopback.close();
    }
  }

  formatStatus(): string {
    const rows = this.listServers();
    if (rows.length === 0) {
      return "No MCP servers configured. Add servers to .mcp.json or ~/.pi/agent/mcp.json.";
    }
    return rows
      .map((row) => {
        const extra = row.error ? ` — ${row.error}` : "";
        return `${row.name}  ${row.status}  ${row.transport}  tools:${row.toolCount}  (${row.source})${extra}`;
      })
      .join("\n");
  }

  private async finishExistingAuth(state: ServerState, redirectUrl: string, signal?: AbortSignal): Promise<string> {
    const url = new URL(redirectUrl);
    const redirectUri = `${url.protocol}//${url.host}${url.pathname}`;
    const provider = this.createOAuthProvider(state, redirectUri);
    await this.connectWithProvider(state, provider, signal, true);
    await this.finishAuthOnProvider(state, provider, url, signal);
    return `Authenticated with "${state.server.name}".`;
  }

  private async finishAuthOnProvider(
    state: ServerState,
    provider: FileOAuthProvider,
    callbackUrl: URL,
    signal?: AbortSignal,
  ): Promise<void> {
    const code = callbackUrl.searchParams.get("code");
    if (!code) throw new PiEssentialsError("OAuth callback did not include an authorization code.", "MCP_OAUTH_FAILED");
    const transport = await this.createHttpTransport(state, provider);
    if (!("finishAuth" in transport) || typeof transport.finishAuth !== "function") {
      throw new PiEssentialsError("This transport does not support OAuth code exchange.", "MCP_OAUTH_FAILED");
    }
    await transport.finishAuth(code);
    await transport.close?.();
    await this.connectWithProvider(state, provider, signal, false);
  }

  private async connectInternal(state: ServerState, signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new PiEssentialsError("MCP manager has been shut down.", "MCP_SHUTDOWN");
    await this.disconnectState(state);
    state.status = "connecting";
    state.error = undefined;
    try {
      const def = state.server.definition;
      if (def.command) {
        await this.connectStdio(state, signal);
      } else if (def.url) {
        const provider = def.auth === "oauth" ? this.createOAuthProvider(state) : undefined;
        await this.connectWithProvider(state, provider, signal, false);
      } else {
        throw new PiEssentialsError(`Server "${state.server.name}" has neither command nor url.`, "MCP_BAD_CONFIG");
      }
      await this.refreshTools(state, signal);
      state.status = "connected";
      this.scheduleIdle(state);
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        state.status = "needs-auth";
        state.error = "OAuth required";
        throw new PiEssentialsError(
          `MCP server "${state.server.name}" requires OAuth. Run mcp({ action: "auth", server: "${state.server.name}" }).`,
          "MCP_NEEDS_AUTH",
        );
      }
      state.status = "failed";
      state.error = errorMessage(error);
      throw this.wrapCallError(state.server.name, error);
    }
  }

  private async connectStdio(state: ServerState, signal?: AbortSignal): Promise<void> {
    const def = state.server.definition;
    const command = interpolateEnvValue(def.command ?? "", process.env);
    if (!command) throw new PiEssentialsError(`Server "${state.server.name}" has an empty command.`, "MCP_BAD_CONFIG");
    const args = (def.args ?? []).map((arg) => interpolateEnvValue(arg, process.env));
    const { values: extraEnv, missing } = interpolateRecord(def.env);
    if (missing.length > 0) {
      throw new PiEssentialsError(
        `Server "${state.server.name}" references missing environment variables: ${missing.join(", ")}`,
        "MCP_BAD_CONFIG",
      );
    }
    const cwd = def.cwd ? interpolateEnvValue(def.cwd, process.env) : this.cwd;
    const transport = new StdioClientTransport({
      command,
      args,
      cwd,
      env: { ...envRecord(process.env), ...extraEnv },
      stderr: "pipe",
    });
    const client = new Client({ name: "pi-essentials", version: "0.1.0" });
    const combined = timeoutSignal(CONNECT_TIMEOUT_MS, signal);
    await this.connectClient(client, transport, combined);
    state.live = { client, transport, lastUsed: Date.now() };
  }

  private createOAuthProvider(state: ServerState, redirectUri?: string): FileOAuthProvider {
    const def = state.server.definition;
    const url = this.resolvedUrl(state);
    const redirect = redirectUri ?? def.oauth?.redirectUri ?? "http://127.0.0.1/callback";
    const staticClient = def.oauth?.clientId
      ? { client_id: def.oauth.clientId, client_secret: def.oauth.clientSecret }
      : undefined;
    return new FileOAuthProvider(
      state.server.name,
      url.toString(),
      redirect,
      {
        client_name: "pi-essentials",
        redirect_uris: [redirect],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: def.oauth?.clientSecret ? "client_secret_post" : "none",
        scope: def.oauth?.scope,
      },
      staticClient,
    );
  }

  private async connectWithProvider(
    state: ServerState,
    provider: FileOAuthProvider | undefined,
    signal: AbortSignal | undefined,
    allowUnauthorized: boolean,
  ): Promise<void> {
    const transport = await this.createHttpTransport(state, provider);
    const client = new Client({ name: "pi-essentials", version: "0.1.0" });
    const combined = timeoutSignal(CONNECT_TIMEOUT_MS, signal);
    try {
      await this.connectClient(client, transport, combined);
      state.live = { client, transport, lastUsed: Date.now() };
    } catch (error) {
      if (error instanceof UnauthorizedError && allowUnauthorized) {
        await transport.close?.().catch(() => undefined);
        await client.close().catch(() => undefined);
        return;
      }
      if (needsSseFallback(error) && !(transport instanceof SSEClientTransport)) {
        await transport.close?.().catch(() => undefined);
        await client.close().catch(() => undefined);
        const sse = await this.createSseTransport(state, provider);
        const sseClient = new Client({ name: "pi-essentials", version: "0.1.0" });
        try {
          await this.connectClient(sseClient, sse, timeoutSignal(CONNECT_TIMEOUT_MS, signal));
          state.live = { client: sseClient, transport: sse, lastUsed: Date.now() };
          return;
        } catch (sseError) {
          await sse.close?.().catch(() => undefined);
          await sseClient.close().catch(() => undefined);
          throw sseError;
        }
      }
      await transport.close?.().catch(() => undefined);
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  private async createHttpTransport(state: ServerState, provider?: FileOAuthProvider): Promise<StreamableHTTPClientTransport> {
    const url = this.resolvedUrl(state);
    return new StreamableHTTPClientTransport(url, {
      requestInit: { headers: this.httpHeaders(state) },
      authProvider: provider,
    });
  }

  private async createSseTransport(state: ServerState, provider?: FileOAuthProvider): Promise<SSEClientTransport> {
    const url = this.resolvedUrl(state);
    return new SSEClientTransport(url, {
      requestInit: { headers: this.httpHeaders(state) },
      authProvider: provider,
    });
  }

  private resolvedUrl(state: ServerState): URL {
    const missing: string[] = [];
    const raw = interpolateEnvValue(state.server.definition.url ?? "", process.env, missing);
    if (missing.length > 0 || !raw) {
      throw new PiEssentialsError(
        `Server "${state.server.name}" URL is missing environment variables: ${missing.join(", ") || "(empty)"}`,
        "MCP_BAD_CONFIG",
      );
    }
    try {
      return new URL(raw);
    } catch {
      throw new PiEssentialsError(`Server "${state.server.name}" has an invalid URL.`, "MCP_BAD_CONFIG");
    }
  }

  private httpHeaders(state: ServerState): Record<string, string> {
    const { values, missing } = interpolateRecord(state.server.definition.headers);
    if (missing.length > 0) {
      throw new PiEssentialsError(
        `Server "${state.server.name}" headers reference missing environment variables: ${missing.join(", ")}`,
        "MCP_BAD_CONFIG",
      );
    }
    const headers: Record<string, string> = { ...values };
    const def = state.server.definition;
    const bearer =
      (def.bearerToken ? interpolateEnvValue(def.bearerToken) : undefined) ||
      (def.bearerTokenEnv ? process.env[def.bearerTokenEnv] : undefined);
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    return headers;
  }

  private async connectClient(client: Client, transport: Transport, signal: AbortSignal): Promise<void> {
    const abort = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(new PiEssentialsError("MCP connection timed out or was cancelled.", "MCP_TIMEOUT", true));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    await Promise.race([client.connect(transport), abort]);
  }

  private async refreshTools(state: ServerState, signal?: AbortSignal): Promise<void> {
    if (!state.live) return;
    const timeoutMs = state.server.definition.requestTimeoutMs ?? this.config.mcp.requestTimeoutMs;
    const tools: CachedTool[] = [];
    let cursor: string | undefined;
    do {
      const listed = await state.live.client.listTools(
        cursor ? { cursor } : undefined,
        { timeout: timeoutMs, signal: timeoutSignal(timeoutMs, signal) },
      );
      for (const tool of listed.tools ?? []) {
        const prefixedName = prefixName(state.server.name, tool.name, state.server.definition.toolPrefix);
        if (!allowedTool(state.server, tool.name, prefixedName)) continue;
        tools.push({
          server: state.server.name,
          name: tool.name,
          prefixedName,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema,
        });
      }
      cursor = listed.nextCursor;
    } while (cursor);
    state.tools = tools;
  }

  private scheduleIdle(state: ServerState): void {
    if (state.live?.idleTimer) clearTimeout(state.live.idleTimer);
    const lifecycle = state.server.definition.lifecycle ?? "lazy";
    if (lifecycle === "keep-alive") return;
    const minutes = state.server.definition.idleTimeout;
    const idleMs = minutes && minutes > 0 ? minutes * 60_000 : this.config.mcp.idleTimeoutMs;
    if (!state.live) return;
    state.live.idleTimer = setTimeout(() => {
      void this.disconnectState(state);
    }, idleMs);
    state.live.idleTimer.unref?.();
  }

  private async disconnectState(state: ServerState): Promise<void> {
    const live = state.live;
    state.live = undefined;
    if (state.status !== "disabled") state.status = state.tools.length > 0 ? "idle" : "idle";
    if (!live) return;
    if (live.idleTimer) clearTimeout(live.idleTimer);
    try {
      await live.client.close();
    } catch {
      // ignore
    }
    try {
      await live.transport.close?.();
    } catch {
      // ignore
    }
  }

  private requireServer(name: string): ServerState {
    const state = this.states.get(name);
    if (!state) {
      const available = [...this.states.keys()].join(", ") || "none";
      throw new PiEssentialsError(`Unknown MCP server "${name}". Available: ${available}`, "MCP_UNKNOWN_SERVER");
    }
    return state;
  }

  private guessServer(toolName: string): string | undefined {
    for (const state of this.states.values()) {
      if (toolName.startsWith(`${state.server.name.replace(/[^A-Za-z0-9_]+/g, "_")}_`)) return state.server.name;
    }
    return undefined;
  }

  private wrapCallError(server: string, error: unknown): PiEssentialsError {
    if (error instanceof PiEssentialsError) return error;
    if (isAbortError(error)) {
      return new PiEssentialsError(`MCP request to "${server}" timed out or was cancelled.`, "MCP_TIMEOUT", true);
    }
    const message = errorMessage(error);
    if (/not valid JSON|Unexpected token|parse/i.test(message)) {
      return new PiEssentialsError(`MCP server "${server}" returned a malformed response.`, "MCP_BAD_RESPONSE");
    }
    return new PiEssentialsError(`MCP server "${server}" failed: ${message}`, "MCP_ERROR", true);
  }
}

export function parseMcpArgs(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      throw new PiEssentialsError("MCP args JSON must be an object.", "MCP_BAD_ARGS");
    } catch (error) {
      if (error instanceof PiEssentialsError) throw error;
      throw new PiEssentialsError("MCP args string is not valid JSON.", "MCP_BAD_ARGS");
    }
  }
  if (typeof args === "object" && !Array.isArray(args)) return args as Record<string, unknown>;
  throw new PiEssentialsError("MCP args must be an object or JSON object string.", "MCP_BAD_ARGS");
}
