import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getWebCacheDir } from "../src/paths.ts";
import { cacheId, getCache, putCache } from "../src/web/cache.ts";
import { readCached } from "../src/web/fetch.ts";
import { safeFetch } from "../src/web/http.ts";

let previousAgentDir: string | undefined;

beforeEach(() => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(os.tmpdir(), "pi-essentials-cache-"));
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

describe("web cache", () => {
  it("round-trips a page by id and by url", () => {
    const id = putCache("https://example.com/a", "Example", "# Body\n\ncontent");
    expect(id).toBe(cacheId("https://example.com/a"));
    expect(getCache(id)?.markdown).toContain("content");
    expect(getCache("https://example.com/a")?.title).toBe("Example");
    expect(getCache("missing")).toBeUndefined();
  });

  it("serves offset windows and tells the model how to continue", () => {
    const body = "x".repeat(100);
    const id = putCache("https://example.com/long", "Long", body);

    const head = readCached(id, 0, 40);
    expect(head.markdown.startsWith("x".repeat(40))).toBe(true);
    expect(head.truncated).toBe(true);
    expect(head.markdown).toContain(`offset: 40`);

    const tail = readCached(id, 60);
    expect(tail.totalChars).toBe(100);
    expect(tail.offset).toBe(60);
  });

  it("explains an expired or unknown cache id instead of throwing a bare error", () => {
    expect(() => readCached("deadbeefdeadbeef")).toThrow(/fetch the url again/i);
  });

  it("removes stale .md files that the index no longer references", () => {
    mkdirSync(getWebCacheDir(), { recursive: true });
    writeFileSync(path.join(getWebCacheDir(), "0123456789abcdef.md"), "orphan");
    putCache("https://example.com/b", "B", "kept");
    const files = readdirSync(getWebCacheDir()).filter((f) => f.endsWith(".md"));
    expect(files).toEqual([`${cacheId("https://example.com/b")}.md`]);
  });
});

describe("safeFetch guards", () => {
  it("refuses loopback and non-http targets before opening a socket", async () => {
    await expect(safeFetch("http://127.0.0.1:1/x", { timeoutMs: 1000, maxBytes: 1024 })).rejects.toThrow(/Blocked IP/);
    await expect(safeFetch("file:///etc/passwd", { timeoutMs: 1000, maxBytes: 1024 })).rejects.toThrow(/http and https/);
    await expect(safeFetch("http://[::1]/x", { timeoutMs: 1000, maxBytes: 1024 })).rejects.toThrow(/Blocked/);
  });
});
