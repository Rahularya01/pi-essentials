import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Force the plaintext-file backend for these persistence tests: this sandbox's
// real OS keyring works, and these tests must not write test entries into it.
// The keyring-specific migration/fallback behavior is covered separately below.
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

let previousAgentDir: string | undefined;

beforeEach(async () => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(os.tmpdir(), "pi-essentials-oauth-"));
  const { resetCredentialStoreForTests } = await import("../src/mcp/credential-store.ts");
  const { resetOAuthCacheForTests } = await import("../src/mcp/oauth.ts");
  resetCredentialStoreForTests();
  resetOAuthCacheForTests();
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

const metadata = { client_name: "pi-essentials", redirect_uris: ["http://127.0.0.1/callback"] };

describe("FileOAuthProvider persistence (file backend)", () => {
  it("hands a fresh provider instance the verifier a prior instance saved for the same server", async () => {
    // This is the exact invariant the two-step auth flow depends on: the browser
    // step and the "I have the redirect URL now" completion step construct two
    // separate FileOAuthProvider instances (often in separate tool calls), and
    // the second one must see what the first one persisted to disk.
    const { FileOAuthProvider } = await import("../src/mcp/oauth.ts");
    const first = new FileOAuthProvider("srv", "https://mcp.example.com", "http://127.0.0.1/callback", metadata);
    await first.saveCodeVerifier("verifier-abc");

    const second = new FileOAuthProvider("srv", "https://mcp.example.com", "http://127.0.0.1/callback", metadata);
    await expect(second.codeVerifier()).resolves.toBe("verifier-abc");
  });

  it("keeps a fresh instance's own in-memory verifier ahead of whatever a concurrent instance wrote", async () => {
    const { FileOAuthProvider } = await import("../src/mcp/oauth.ts");
    const a = new FileOAuthProvider("srv", "https://mcp.example.com", "http://127.0.0.1/callback", metadata);
    await a.saveCodeVerifier("verifier-a");
    // Simulate a second, unrelated attempt overwriting the on-disk record.
    const b = new FileOAuthProvider("srv", "https://mcp.example.com", "http://127.0.0.1/callback", metadata);
    await b.saveCodeVerifier("verifier-b");
    // `a` still has its own verifier cached locally even though disk now holds "verifier-b".
    await expect(a.codeVerifier()).resolves.toBe("verifier-a");
  });

  it("round-trips tokens and client information across instances", async () => {
    const { FileOAuthProvider } = await import("../src/mcp/oauth.ts");
    const provider = new FileOAuthProvider("srv", "https://mcp.example.com", "http://127.0.0.1/callback", metadata);
    await provider.saveTokens({ access_token: "at", token_type: "bearer" });
    await provider.saveClientInformation({ client_id: "abc", redirect_uris: ["http://127.0.0.1/callback"] });

    const reloaded = new FileOAuthProvider("srv", "https://mcp.example.com", "http://127.0.0.1/callback", metadata);
    await expect(reloaded.tokens()).resolves.toEqual({ access_token: "at", token_type: "bearer" });
    await expect(reloaded.clientInformation()).resolves.toEqual({
      client_id: "abc",
      redirect_uris: ["http://127.0.0.1/callback"],
    });
  });

  it("clears the saved verifier once tokens are saved, so a stale verifier cannot be reused", async () => {
    const { FileOAuthProvider } = await import("../src/mcp/oauth.ts");
    const provider = new FileOAuthProvider("srv", "https://mcp.example.com", "http://127.0.0.1/callback", metadata);
    await provider.saveCodeVerifier("verifier-abc");
    await provider.saveTokens({ access_token: "at", token_type: "bearer" });

    const reloaded = new FileOAuthProvider("srv", "https://mcp.example.com", "http://127.0.0.1/callback", metadata);
    await expect(reloaded.codeVerifier()).rejects.toThrow(/no pkce code verifier/i);
  });

  it("invalidates a stored record when the server URL changes", async () => {
    const { FileOAuthProvider } = await import("../src/mcp/oauth.ts");
    const provider = new FileOAuthProvider("srv", "https://mcp.example.com/v1", "http://127.0.0.1/callback", metadata);
    await provider.saveTokens({ access_token: "at", token_type: "bearer" });

    // Same server *name* but a different URL must not inherit the old server's tokens.
    const movedServer = new FileOAuthProvider("srv", "https://mcp.example.com/v2", "http://127.0.0.1/callback", metadata);
    await expect(movedServer.tokens()).resolves.toBeUndefined();
  });

  it("removes stored tokens and the in-memory verifier on clearTokens", async () => {
    const { FileOAuthProvider } = await import("../src/mcp/oauth.ts");
    const provider = new FileOAuthProvider("srv", "https://mcp.example.com", "http://127.0.0.1/callback", metadata);
    await provider.saveCodeVerifier("verifier-abc");
    await provider.saveTokens({ access_token: "at", token_type: "bearer" });
    await provider.clearTokens();

    await expect(provider.tokens()).resolves.toBeUndefined();
    await expect(provider.codeVerifier()).rejects.toThrow();
    const reloaded = new FileOAuthProvider("srv", "https://mcp.example.com", "http://127.0.0.1/callback", metadata);
    await expect(reloaded.tokens()).resolves.toBeUndefined();
  });

  it("prefers a statically configured client over a stored one", async () => {
    const { FileOAuthProvider } = await import("../src/mcp/oauth.ts");
    const staticClient = { client_id: "static-id" };
    const provider = new FileOAuthProvider(
      "srv",
      "https://mcp.example.com",
      "http://127.0.0.1/callback",
      metadata,
      staticClient,
    );
    await provider.saveClientInformation({ client_id: "dynamic-id", redirect_uris: ["http://127.0.0.1/callback"] });
    await expect(provider.clientInformation()).resolves.toBe(staticClient);
  });
});

describe("credential store selection", () => {
  it("falls back to the file backend and reports why when no OS credential store is available", async () => {
    const { resolveCredentialStore } = await import("../src/mcp/credential-store.ts");
    const { store, warning } = await resolveCredentialStore();
    expect(store.backend).toBe("file");
    expect(warning).toMatch(/no os credential store/i);
  });
});
