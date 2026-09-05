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
import { FileOAuthProvider, maybeOpenUrl, startLoopbackCallback, type LoopbackCallback } from "./oauth.ts";
import type { CachedTool, McpFileShape, ResolvedServer, ServerSnapshot, ServerStatus } from "./types.ts";

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
  /** Set once automatic discovery has tried this server, so it is not retried on every call. */
  discovered?: boolean;
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
  const anyErr = error as { status?: unknown; code?: unknown };
  if (typeof anyErr.status === "number") return anyErr.status;
  if (typeof anyErr.code === "number") return anyErr.code;
  // Only trust a status read out of the message when it is phrased as one, so an
  // unrelated "404" inside a server's prose does not trigger the SSE fallback.
  const match = /\b(?:HTTP|status(?: code)?:?)\s*(\d{3})\b/i.exec(errorMessage(error));
  return match ? Number(match[1]) : undefined;
}

function needsSseFallback(error: unknown): boolean {
  const status = httpStatus(error);
  return status === 404 || status === 405 || status === 406 || status === 415;
}

/** Longest inline value kept for a non-text content part before summarizing it. */
const MAX_INLINE_PART_CHARS = 2000;

function describeContentPart(item: Record<string, unknown>): string {
  const type = typeof item.type === "string" ? item.type : "unknown";

  // Binary payloads (screenshots, audio) must never be pasted into the parent
  // context: a single base64 image can be megabytes of unreadable tokens.
  if (typeof item.data === "string") {
    const mime = typeof item.mimeType === "string" ? item.mimeType : "application/octet-stream";
    const kb = Math.round((item.data.length * 3) / 4 / 1024);
    return `[${type} content omitted: ${mime}, ~${kb} KB base64]`;
  }
  if (type === "resource" || type === "resource_link") {
    const resource = (item.resource ?? item) as Record<string, unknown>;
    if (typeof resource.text === "string") return resource.text;
    if (typeof resource.blob === "string") {
      const mime = typeof resource.mimeType === "string" ? resource.mimeType : "application/octet-stream";
      return `[resource omitted: ${String(resource.uri ?? "unknown")} (${mime})]`;
    }
    return `[resource: ${String(resource.uri ?? "unknown")}]`;
  }
  try {
    const json = JSON.stringify(item);
    return json.length > MAX_INLINE_PART_CHARS
      ? `${json.slice(0, MAX_INLINE_PART_CHARS)}… [${json.length - MAX_INLINE_PART_CHARS} more characters omitted]`
      : json;
  } catch {
    return `[unserializable ${type} content]`;
  }
}

function stringifyToolResult(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const record = result as { content?: unknown; structuredContent?: unknown; isError?: boolean };
  const content = record.content;

  if (!Array.isArray(content)) {
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }

  const parts: string[] = [];
  const textJson = new Set<string>();
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (rec.type === "text" && typeof rec.text === "string") {
      parts.push(rec.text);
      try {
        textJson.add(JSON.stringify(JSON.parse(rec.text)));
      } catch {
        // Ordinary prose is not a structured-content duplicate.
      }
    } else parts.push(describeContentPart(rec));
  }

  if (record.structuredContent !== undefined) {
    try {
      const compact = JSON.stringify(record.structuredContent);
      // Some MCP servers mirror structuredContent into a JSON text part. Keep
      // both kinds of output, but do not paste the same JSON into context twice.
      if (!textJson.has(compact)) parts.push(JSON.stringify(record.structuredContent, null, 2));
    } catch {
      // Ignore an unserializable structured value; content parts remain useful.
    }
  }

  if (record.isError) return parts.join("\n") || "MCP tool returned an error.";
  return parts.join("\n\n") || "(empty MCP result)";
}

function mcpResultError(result: unknown): PiEssentialsError | undefined {
  if (!result || typeof result !== "object" || !(result as { isError?: unknown }).isError) return undefined;
  return new PiEssentialsError(stringifyToolResult(result), "MCP_TOOL_ERROR");
}

function resolveTool(tools: CachedTool[], name: string): CachedTool | undefined {
  const prefixed = tools.find((tool) => tool.prefixedName === name);
  if (prefixed) return prefixed;
  const unprefixed = tools.filter((tool) => tool.name === name);
  if (unprefixed.length <= 1) return unprefixed[0];
  throw new PiEssentialsError(
    `Ambiguous MCP tool "${name}". Use a prefixed tool name: ${unprefixed.map((tool) => tool.prefixedName).join(", ")}.`,
    "MCP_AMBIGUOUS_TOOL",
  );
}

export const __testing = { stringifyToolResult, mcpResultError, resolveTool, httpStatus };

interface PendingAuth {
  loopback: LoopbackCallback;
  timeout: NodeJS.Timeout;
  /** The exact redirect URI this attempt advertised, needed to complete with a bare `code`. */
  redirectUri: string;
}

export class McpManager {
  private readonly states = new Map<string, ServerState>();
  private closed = false;
  /** Config problems surfaced through the UI at session start, not the console. */
  readonly warnings: string[] = [];
  private readonly fileSettings: McpFileShape["settings"];
  /** One in-flight browser-based auth attempt per server; see authStart/authComplete. */
  private readonly pendingAuth = new Map<string, PendingAuth>();
  private readonly authListeners = new Set<(server: string, message: string) => void>();

  constructor(
    private readonly cwd: string,
    private readonly config: ResolvedConfig,
  ) {
    const { servers, warnings, settings } = loadMcpServers(cwd);
    this.warnings.push(...warnings);
    this.fileSettings = settings;
    for (const server of servers) {
      this.states.set(server.name, {
        server,
        status: server.definition.disabled === true ? "disabled" : "idle",
        tools: [],
      });
    }
  }

  /** Allow a manager to be reused after `shutdown()` (for example across /reload). */
  reset(): void {
    this.closed = false;
    for (const state of this.states.values()) state.discovered = false;
  }

  private requestTimeoutFor(state: ServerState): number {
    return (
      state.server.definition.requestTimeoutMs ?? this.fileSettings?.requestTimeoutMs ?? this.config.mcp.requestTimeoutMs
    );
  }

  private idleTimeoutFor(state: ServerState): number {
    const minutes = state.server.definition.idleTimeout ?? this.fileSettings?.idleTimeout;
    if (minutes && minutes > 0) return minutes * 60_000;
    return this.config.mcp.idleTimeoutMs;
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
    return resolveTool(this.allCachedTools(), name);
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
    const attempt = this.connectInternal(state, signal);
    state.connectPromise = attempt;
    try {
      await attempt;
    } finally {
      // A concurrent force-reconnect may already have installed a newer attempt.
      if (state.connectPromise === attempt) state.connectPromise = undefined;
    }
  }

  async disconnect(name?: string): Promise<void> {
    const targets = name ? [this.requireServer(name)] : [...this.states.values()];
    await Promise.all(targets.map((state) => this.disconnectState(state)));
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const name of [...this.pendingAuth.keys()]) this.cancelPendingAuth(name);
    await this.disconnect();
  }

  /** Notified when a background browser-based auth (started by authStart) finishes without a follow-up call. */
  onAuthUpdate(listener: (server: string, message: string) => void): () => void {
    this.authListeners.add(listener);
    return () => this.authListeners.delete(listener);
  }

  private cancelPendingAuth(name: string): void {
    const pending = this.pendingAuth.get(name);
    if (!pending) return;
    this.pendingAuth.delete(name);
    clearTimeout(pending.timeout);
    pending.loopback.close();
  }

  /** Force a reconnect of every enabled server (used by /mcp reconnect). */
  async refreshAll(signal?: AbortSignal): Promise<void> {
    await Promise.all(
      [...this.states.values()]
        .filter((state) => state.status !== "disabled")
        .map((state) => {
          state.discovered = false;
          return this.connect(state.server.name, signal, true).catch(() => undefined);
        }),
    );
  }

  /**
   * Make sure every enabled server has been listed at least once. Servers that
   * already have cached tools are left alone, so discovery does not tear down
   * healthy connections.
   */
  async ensureAllTools(signal?: AbortSignal): Promise<void> {
    const pending = [...this.states.values()].filter(
      (state) => state.status !== "disabled" && state.tools.length === 0 && !state.discovered,
    );
    await Promise.all(
      pending.map(async (state) => {
        // Mark first: a server that fails or exposes no tools must not be retried
        // on every subsequent search/list/describe call.
        state.discovered = true;
        await this.connect(state.server.name, signal).catch(() => undefined);
      }),
    );
  }

  /** Human-readable reasons why discovery produced no tools. */
  discoveryProblems(): string[] {
    return this.listServers()
      .filter((row) => row.status === "failed" || row.status === "needs-auth")
      .map((row) => `${row.name}: ${row.status}${row.error ? ` — ${row.error}` : ""}`);
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
    const timeoutMs = this.requestTimeoutFor(state);
    const combined = timeoutSignal(timeoutMs, signal);
    try {
      const result = await state.live.client.callTool({ name, arguments: parseMcpArgs(args) }, undefined, {
        timeout: timeoutMs,
        signal: combined,
      });
      state.live.lastUsed = Date.now();
      this.scheduleIdle(state);
      const failure = mcpResultError(result);
      if (failure) throw failure;
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
        await this.markConnected(state, signal);
        state.discovered = false;
        return `Connected to "${name}" (existing credentials worked).`;
      }
      if (!authorize) {
        throw new PiEssentialsError(`OAuth did not produce an authorization URL for "${name}".`, "MCP_OAUTH_FAILED");
      }
      const opened = await maybeOpenUrl(authorize.toString());
      const callback = await loopback.waitForCallback(5 * 60_000);
      await this.finishAuthOnProvider(state, provider, callback, signal);
      state.discovered = false;
      return opened
        ? `Authenticated with "${name}".`
        : `Authenticated with "${name}". Authorization URL was: ${authorize.toString()}`;
    } finally {
      loopback.close();
    }
  }

  /**
   * Non-blocking counterpart to `auth()`: returns the authorization URL right
   * away instead of waiting up to 5 minutes for the browser callback. A
   * background listener still completes the flow automatically if the
   * callback does arrive; otherwise call `authComplete` with the pasted
   * redirect URL (works from a different call, session, or even process,
   * since the PKCE verifier is read back from the credential store) or the
   * bare `code` (only within this same process, since that needs the exact
   * redirect URI this attempt advertised).
   */
  async authStart(name: string, signal?: AbortSignal): Promise<{ authorizeUrl?: string; message: string }> {
    const state = this.requireServer(name);
    if (!state.server.definition.url) {
      throw new PiEssentialsError(`Server "${name}" is stdio and does not use OAuth.`, "MCP_NO_OAUTH");
    }
    await this.disconnectState(state);
    this.cancelPendingAuth(name);

    const loopback = await startLoopbackCallback();
    const provider = this.createOAuthProvider(state, loopback.redirectUri);
    let authorize: URL | undefined;
    try {
      await this.connectWithProvider(state, provider, signal, true);
      authorize = provider.takeRedirectUrl();
    } catch (error) {
      loopback.close();
      throw error;
    }

    if (!authorize && state.live) {
      loopback.close();
      await this.markConnected(state, signal);
      state.discovered = false;
      return { message: `Connected to "${name}" (existing credentials worked).` };
    }
    if (!authorize) {
      loopback.close();
      throw new PiEssentialsError(`OAuth did not produce an authorization URL for "${name}".`, "MCP_OAUTH_FAILED");
    }

    const opened = await maybeOpenUrl(authorize.toString());
    const timeout = setTimeout(() => this.cancelPendingAuth(name), 5 * 60_000);
    timeout.unref?.();
    this.pendingAuth.set(name, { loopback, timeout, redirectUri: loopback.redirectUri });

    loopback
      .waitForCallback(5 * 60_000)
      .then(async (callback) => {
        // Superseded by a cancel, a manual authComplete, or a fresh authStart for the same server.
        if (this.pendingAuth.get(name)?.loopback !== loopback) return;
        this.pendingAuth.delete(name);
        clearTimeout(timeout);
        try {
          await this.finishAuthOnProvider(state, provider, callback, signal);
          state.discovered = false;
          this.notifyAuth(name, `Authenticated with "${name}".`);
        } catch (error) {
          this.notifyAuth(name, `OAuth for "${name}" failed: ${errorMessage(error)}`);
        } finally {
          loopback.close();
        }
      })
      .catch(() => {
        if (this.pendingAuth.get(name)?.loopback === loopback) this.cancelPendingAuth(name);
        else loopback.close();
      });

    const authorizeUrl = authorize.toString();
    return {
      authorizeUrl,
      message: opened
        ? `Opened a browser to authenticate "${name}". Waiting for the callback in the background; ` +
          `if it does not complete, call authComplete with the redirect URL.`
        : `Open this URL to authenticate "${name}": ${authorizeUrl}\n` +
          `Waiting for the callback in the background; if it does not complete, call authComplete with the redirect URL.`,
    };
  }

  /** Finish an auth-start flow with a pasted redirect URL, or (same-process only) a bare code. */
  async authComplete(name: string, input: { redirectUrl?: string; code?: string }, signal?: AbortSignal): Promise<string> {
    const state = this.requireServer(name);
    if (!state.server.definition.url) {
      throw new PiEssentialsError(`Server "${name}" is stdio and does not use OAuth.`, "MCP_NO_OAUTH");
    }
    const pending = this.pendingAuth.get(name);
    this.cancelPendingAuth(name);

    if (input.redirectUrl) {
      await this.disconnectState(state);
      return this.finishExistingAuth(state, input.redirectUrl, signal);
    }
    if (input.code) {
      const redirectUri = pending?.redirectUri ?? state.server.definition.oauth?.redirectUri;
      if (!redirectUri) {
        throw new PiEssentialsError(
          `No pending authStart redirect URI for "${name}" and none is configured; pass the full redirectUrl instead.`,
          "MCP_OAUTH_FAILED",
        );
      }
      await this.disconnectState(state);
      const provider = this.createOAuthProvider(state, redirectUri);
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", input.code);
      await this.finishAuthOnProvider(state, provider, callback, signal);
      state.discovered = false;
      return `Authenticated with "${name}".`;
    }
    throw new PiEssentialsError("authComplete requires redirectUrl or code.", "MCP_BAD_ARGS");
  }

  /** Clear stored OAuth credentials for a server and disconnect it. */
  async logout(name: string): Promise<string> {
    const state = this.requireServer(name);
    if (!state.server.definition.url) {
      throw new PiEssentialsError(`Server "${name}" is stdio and does not use OAuth.`, "MCP_NO_OAUTH");
    }
    this.cancelPendingAuth(name);
    await this.disconnectState(state);
    const provider = this.createOAuthProvider(state);
    await provider.clearTokens();
    if (state.status !== "disabled") state.status = "idle";
    state.tools = [];
    state.discovered = false;
    return `Cleared stored OAuth credentials for "${name}".`;
  }

  private notifyAuth(server: string, message: string): void {
    for (const listener of this.authListeners) listener(server, message);
  }

  formatStatus(): string {
    const rows = this.listServers();
    if (rows.length === 0) {
      return "No MCP servers configured. Add servers to .mcp.json or ~/.pi/agent/mcp.json.";
    }
    const width = (pick: (row: ServerSnapshot) => string) => Math.max(...rows.map((row) => pick(row).length));
    const nameWidth = Math.max(6, width((row) => row.name));
    const statusWidth = Math.max(6, width((row) => row.status));
    const header = `${"SERVER".padEnd(nameWidth)}  ${"STATUS".padEnd(statusWidth)}  TRANSPORT  TOOLS  SOURCE`;
    const body = rows.map((row) => {
      const extra = row.error ? `\n${" ".repeat(nameWidth + 2)}└─ ${row.error}` : "";
      return (
        `${row.name.padEnd(nameWidth)}  ${row.status.padEnd(statusWidth)}  ${row.transport.padEnd(9)}  ` +
        `${String(row.toolCount).padStart(5)}  ${row.source}${extra}`
      );
    });
    const lazy = rows.some((row) => row.status === "idle" && row.toolCount === 0);
    const hint = lazy ? "\n\nLazy servers list their tools on first use; run /mcp reconnect to connect now." : "";
    return `${header}\n${body.join("\n")}${hint}`;
  }

  private async finishExistingAuth(state: ServerState, redirectUrl: string, signal?: AbortSignal): Promise<string> {
    const url = new URL(redirectUrl);
    const redirectUri = `${url.protocol}//${url.host}${url.pathname}`;
    const provider = this.createOAuthProvider(state, redirectUri);
    // Do not run connectWithProvider here: it would trigger a fresh OAuth
    // discovery/registration attempt and mint a new PKCE code_verifier, silently
    // invalidating the one the authorization code in `redirectUrl` was issued
    // against. finishAuthOnProvider reads the verifier persisted by the earlier
    // auth() call that produced this redirect, exchanges the code, and connects.
    await this.finishAuthOnProvider(state, provider, url, signal);
    state.discovered = false;
    return `Authenticated with "${state.server.name}".`;
  }

  private async finishAuthOnProvider(
    state: ServerState,
    provider: FileOAuthProvider,
    callbackUrl: URL,
    signal?: AbortSignal,
  ): Promise<void> {
    const denied = callbackUrl.searchParams.get("error");
    if (denied) {
      const detail = callbackUrl.searchParams.get("error_description") ?? denied;
      throw new PiEssentialsError(`OAuth was denied by the provider: ${detail}`, "MCP_OAUTH_FAILED");
    }
    const code = callbackUrl.searchParams.get("code");
    if (!code) throw new PiEssentialsError("OAuth callback did not include an authorization code.", "MCP_OAUTH_FAILED");
    const transport = await this.createHttpTransport(state, provider);
    if (!("finishAuth" in transport) || typeof transport.finishAuth !== "function") {
      throw new PiEssentialsError("This transport does not support OAuth code exchange.", "MCP_OAUTH_FAILED");
    }
    await transport.finishAuth(code);
    await transport.close?.();
    await this.connectWithProvider(state, provider, signal, false);
    await this.markConnected(state, signal);
  }

  /**
   * `connectWithProvider` only sets `state.live`; it does not update status or
   * tools the way `connectInternal` does. Both OAuth completion paths call it
   * directly, so without this, a freshly authenticated server keeps reporting
   * its pre-auth status (typically "needs-auth" with 0 tools) forever: `connect()`
   * short-circuits on an existing `state.live` before `connectInternal` ever runs.
   */
  private async markConnected(state: ServerState, signal?: AbortSignal): Promise<void> {
    if (!state.live) return;
    await this.refreshTools(state, signal);
    state.status = "connected";
    state.error = undefined;
    this.scheduleIdle(state);
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
    const timeoutMs = this.requestTimeoutFor(state);
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
    if (!state.live) return;
    if ((state.server.definition.lifecycle ?? "lazy") === "keep-alive") return;
    state.live.idleTimer = setTimeout(() => {
      void this.disconnectState(state);
    }, this.idleTimeoutFor(state));
    state.live.idleTimer.unref?.();
  }

  private async disconnectState(state: ServerState): Promise<void> {
    const live = state.live;
    state.live = undefined;
    // "disabled", "failed" and "needs-auth" describe the server, not the socket,
    // so only a live/connecting server falls back to "idle".
    if (state.status === "connected" || state.status === "connecting") state.status = "idle";
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
    let best: { name: string; length: number } | undefined;
    for (const state of this.states.values()) {
      const prefix = `${state.server.name.replace(/[^A-Za-z0-9_]+/g, "_")}_`;
      if (!toolName.startsWith(prefix)) continue;
      // "a_b" and "a" both prefix "a_b_c"; the longer match is the real server.
      if (!best || prefix.length > best.length) best = { name: state.server.name, length: prefix.length };
    }
    return best?.name;
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
