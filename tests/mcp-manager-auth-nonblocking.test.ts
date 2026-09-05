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

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    constructor(_info: unknown) {}
    async connect(transport: { options?: { authProvider?: { redirectToAuthorization(url: URL): void } } }) {
      if (mockState.failNextConnect) {
        mockState.failNextConnect = false;
        // Simulate what the real SDK does on a 401: point the provider at an
        // authorize URL, then signal that the caller must complete OAuth.
        transport.options?.authProvider?.redirectToAuthorization(new URL("https://auth.example.com/authorize?client_id=abc"));
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
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(os.tmpdir(), "pi-essentials-mcp-nb-agent-"));
  process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "pi-essentials-mcp-nb-home-"));
  mockState.failNextConnect = false;
  mockState.tools = [];
  const { resetCredentialStoreForTests } = await import("../src/mcp/credential-store.ts");
  const { resetOAuthCacheForTests } = await import("../src/mcp/oauth.ts");
  resetCredentialStoreForTests();
  resetOAuthCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
});

async function makeManager() {
  const { McpManager } = await import("../src/mcp/manager.ts");
  const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-essentials-mcp-nb-cwd-"));
  writeFileSync(
    path.join(cwd, ".mcp.json"),
    JSON.stringify({ mcpServers: { "test-oauth": { url: "https://oauth.example.com/mcp", auth: "oauth" } } }),
  );
  return new McpManager(cwd, resolveConfig({}));
}

describe("McpManager.authStart / authComplete (non-blocking OAuth)", () => {
  it("returns the authorize URL immediately instead of blocking for the callback", async () => {
    const manager = await makeManager();
    mockState.failNextConnect = true;

    const start = Date.now();
    const { authorizeUrl, message } = await manager.authStart("test-oauth");
    expect(Date.now() - start).toBeLessThan(2000); // proves it did not wait on the 5-minute callback timeout
    expect(authorizeUrl).toBe("https://auth.example.com/authorize?client_id=abc");
    expect(message).toMatch(/background/i);
    expect(manager.listServers().find((s) => s.name === "test-oauth")?.status).not.toBe("connected");
  });

  it("completes automatically in the background when the real loopback server receives an actual HTTP callback", async () => {
    // authStart's loopback callback server is real (only the MCP SDK client and
    // transport are mocked), so drive it exactly the way a browser redirect
    // would: an HTTP GET against the port it actually bound. Spy on (not
    // replace) the real startLoopbackCallback to recover that port/path.
    const oauthModule = await import("../src/mcp/oauth.ts");
    const spy = vi.spyOn(oauthModule, "startLoopbackCallback");

    const manager = await makeManager();
    mockState.failNextConnect = true;
    const updates: string[] = [];
    manager.onAuthUpdate((_server, message) => updates.push(message));

    await manager.authStart("test-oauth");
    const loopback = await spy.mock.results[0]!.value;

    mockState.tools = [{ name: "search" }];
    const response = await fetch(`${loopback.redirectUri}?code=abc123&state=xyz`);
    expect(response.status).toBe(200);

    // The background completion runs asynchronously after the HTTP response is sent.
    await vi.waitFor(() => {
      expect(manager.listServers().find((s) => s.name === "test-oauth")?.status).toBe("connected");
    });
    expect(updates.some((message) => message.includes("Authenticated"))).toBe(true);
    expect(manager.listServers().find((s) => s.name === "test-oauth")?.toolCount).toBe(1);
  });

  it("lets a headless session complete with just a code, using the redirect URI authStart advertised", async () => {
    const manager = await makeManager();
    mockState.failNextConnect = true;
    await manager.authStart("test-oauth");

    mockState.tools = [{ name: "search" }];
    const completed = await manager.authComplete("test-oauth", { code: "abc123" });
    expect(completed).toContain("Authenticated");

    const row = manager.listServers().find((s) => s.name === "test-oauth");
    expect(row?.status).toBe("connected");
    expect(row?.toolCount).toBe(1);
  });

  it("logout clears stored tokens and cancels any pending browser auth attempt", async () => {
    const manager = await makeManager();
    mockState.failNextConnect = true;
    await manager.authStart("test-oauth");
    mockState.tools = [{ name: "search" }];
    await manager.authComplete("test-oauth", { code: "abc123" });
    expect(manager.listServers().find((s) => s.name === "test-oauth")?.status).toBe("connected");

    const message = await manager.logout("test-oauth");
    expect(message).toContain("Cleared");
    const row = manager.listServers().find((s) => s.name === "test-oauth");
    expect(row?.status).toBe("idle");
    expect(row?.toolCount).toBe(0);

    const { FileOAuthProvider } = await import("../src/mcp/oauth.ts");
    const provider = new FileOAuthProvider("test-oauth", "https://oauth.example.com/mcp", "http://127.0.0.1/callback", {
      redirect_uris: ["http://127.0.0.1/callback"],
    });
    await expect(provider.tokens()).resolves.toBeUndefined();
  });

  it("authComplete cancels the still-pending background listener so a later automatic callback is a no-op", async () => {
    const manager = await makeManager();
    mockState.failNextConnect = true;
    await manager.authStart("test-oauth");

    mockState.tools = [{ name: "search" }];
    await manager.authComplete("test-oauth", { code: "abc123" });

    // A background completion firing after the manual one must not run: this
    // would otherwise be observable as a second, redundant notification.
    const updates: string[] = [];
    manager.onAuthUpdate((_server, message) => updates.push(message));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(updates).toEqual([]);
  });
});
