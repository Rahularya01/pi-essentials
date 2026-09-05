import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { resolveConfig } from "../src/config.ts";

const mockState = vi.hoisted(() => ({
  failNextConnect: false,
  tools: [] as Array<{ name: string; description?: string }>,
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    constructor(_info: unknown) {}
    async connect(_transport: unknown) {
      if (mockState.failNextConnect) {
        mockState.failNextConnect = false;
        throw new UnauthorizedError("auth required");
      }
    }
    async close() {}
    async listTools() {
      return { tools: mockState.tools };
    }
    async callTool() {
      return { content: [{ type: "text", text: "ok" }] };
    }
  },
}));

// Force the plaintext-file credential backend: this test must never touch a
// real OS keychain, on this machine or in CI.
vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    async setPassword(): Promise<void> {
      throw new Error("keyring unavailable in tests");
    }
    async getPassword(): Promise<string | undefined> {
      throw new Error("keyring unavailable in tests");
    }
    async deletePassword(): Promise<boolean> {
      throw new Error("keyring unavailable in tests");
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(
      public url: URL,
      public options: { authProvider?: unknown },
    ) {}
    async close() {}
    async finishAuth(_code: string) {}
  },
}));

let previousAgentDir: string | undefined;
let previousHome: string | undefined;

beforeEach(async () => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  previousHome = process.env.HOME;
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(os.tmpdir(), "pi-essentials-mcp-auth-agent-"));
  process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "pi-essentials-mcp-auth-home-"));
  mockState.failNextConnect = false;
  mockState.tools = [];
  const { resetCredentialStoreForTests } = await import("../src/mcp/credential-store.ts");
  const { resetOAuthCacheForTests } = await import("../src/mcp/oauth.ts");
  resetCredentialStoreForTests();
  resetOAuthCacheForTests();
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
});

async function makeManager() {
  const { McpManager } = await import("../src/mcp/manager.ts");
  const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-essentials-mcp-auth-cwd-"));
  writeFileSync(
    path.join(cwd, ".mcp.json"),
    JSON.stringify({ mcpServers: { "test-oauth": { url: "https://oauth.example.com/mcp", auth: "oauth" } } }),
  );
  return new McpManager(cwd, resolveConfig({}));
}

describe("McpManager OAuth completion updates status and tools", () => {
  it("moves a server from needs-auth to connected (with tools) once auth completes via a pasted redirect URL", async () => {
    const manager = await makeManager();

    mockState.failNextConnect = true;
    await expect(manager.connect("test-oauth")).rejects.toThrow(/OAuth/);
    expect(manager.listServers().find((s) => s.name === "test-oauth")?.status).toBe("needs-auth");

    mockState.tools = [{ name: "search", description: "Search things" }];
    const message = await manager.auth("test-oauth", "http://127.0.0.1:9/callback?code=abc123&state=xyz");
    expect(message).toContain("Authenticated");

    // Before the fix, connectWithProvider only sets `state.live`; nothing updates
    // status/tools, and connect() short-circuits on an existing `state.live`
    // before connectInternal (which normally does that bookkeeping) ever runs
    // again -- so this would incorrectly stay "needs-auth" with 0 tools forever.
    const row = manager.listServers().find((s) => s.name === "test-oauth");
    expect(row?.status).toBe("connected");
    expect(row?.toolCount).toBe(1);
    expect(row?.error).toBeUndefined();
  });
});
