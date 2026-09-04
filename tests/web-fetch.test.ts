import http from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fetchPage } from "../src/web/fetch.ts";
import { safeFetch } from "../src/web/http.ts";

const CONFIG = { timeoutMs: 5000, maxBytes: 1_000_000, maxChars: 200, jinaFallback: false };

interface Route {
  status?: number;
  body?: string | Buffer;
  headers?: Record<string, string>;
}

const routes = new Map<string, Route>();
let server: http.Server;
let origin: string;
let allowedHosts: Set<string>;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const route = routes.get(new URL(req.url ?? "/", "http://x").pathname);
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("no route");
      return;
    }
    res.writeHead(route.status ?? 200, { "content-type": "text/html", ...route.headers });
    res.end(route.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind test server");
  origin = `http://127.0.0.1:${address.port}`;
  // Only this exact host:port is trusted; everything else on loopback stays blocked.
  allowedHosts = new Set([`127.0.0.1:${address.port}`]);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let previousAgentDir: string | undefined;

beforeEach(() => {
  routes.clear();
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(os.tmpdir(), "pi-essentials-e2e-"));
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

const fetchLocal = (pathname: string, slice?: { offset?: number; limit?: number }) =>
  fetchPage(`${origin}${pathname}`, CONFIG, undefined, slice, allowedHosts);

describe("fetchPage end to end", () => {
  it("extracts an article, paginates it, and points at the next slice", async () => {
    const paragraphs = "<p>Paragraph about installing the thing correctly and carefully.</p>".repeat(12);
    routes.set("/guide", {
      body: `<html><head><title>Guide</title></head><body><article><h1>Guide</h1>${paragraphs}</article></body></html>`,
    });

    const first = await fetchLocal("/guide");
    expect(first.title).toBe("Guide");
    expect(first.markdown).toContain("# Guide");
    expect(first.truncated).toBe(true);
    expect(first.totalChars).toBeGreaterThan(200);
    expect(first.markdown).toMatch(/offset: 200/);

    const second = await fetchLocal("/guide", { offset: 200 });
    expect(second.offset).toBe(200);
    expect(second.markdown).not.toContain("# Guide");

    const last = await fetchLocal("/guide", { offset: first.totalChars - 10, limit: 10 });
    expect(last.markdown).toContain("End of cached page");
    expect(last.markdown).not.toContain("Continue with web_fetch");
  });

  it("returns json verbatim rather than through Readability", async () => {
    routes.set("/api", { body: '{"a":1}', headers: { "content-type": "application/json" } });
    expect((await fetchLocal("/api")).markdown).toBe('{"a":1}');
  });

  it("decodes a gzip-encoded response", async () => {
    routes.set("/gz", {
      body: zlib.gzipSync(Buffer.from("<html><body><p>compressed payload</p></body></html>", "utf8")),
      headers: { "content-encoding": "gzip" },
    });
    expect((await fetchLocal("/gz")).markdown).toContain("compressed payload");
  });

  it("decodes a non-UTF-8 response using the declared charset", async () => {
    routes.set("/latin", {
      body: Buffer.from([0x3c, 0x70, 0x3e, 0x63, 0x61, 0x66, 0xe9, 0x3c, 0x2f, 0x70, 0x3e]),
      headers: { "content-type": "text/html; charset=ISO-8859-1" },
    });
    expect((await fetchLocal("/latin")).markdown).toContain("café");
  });

  it("refuses binary responses with an explanation", async () => {
    routes.set("/x.png", { body: "binary", headers: { "content-type": "image/png" } });
    await expect(fetchLocal("/x.png")).rejects.toThrow(/binary content/);
  });

  it("reports an unreadable page instead of returning an empty result", async () => {
    routes.set("/spa", { body: "<html><body><div id=root></div></body></html>" });
    expect((await fetchLocal("/spa")).markdown).toMatch(/no readable text/i);
  });

  it("surfaces an http error when the jina fallback is off", async () => {
    routes.set("/down", { status: 503, body: "nope", headers: { "content-type": "text/plain" } });
    await expect(fetchLocal("/down")).rejects.toThrow(/HTTP 503/);
  });

  it("re-validates every redirect hop against the blocklist", async () => {
    // Same host, different port: outside the allowlist, so it must be blocked.
    routes.set("/start", { status: 302, headers: { location: "http://127.0.0.1:9/secret" } });
    await expect(fetchLocal("/start")).rejects.toThrow(/Blocked IP/);
  });

  it("follows an allowed same-origin redirect", async () => {
    routes.set("/from", { status: 302, headers: { location: "/to" } });
    routes.set("/to", { body: "<html><body><p>arrived</p></body></html>" });
    expect((await fetchLocal("/from")).markdown).toContain("arrived");
  });

  it("stops downloading at maxBytes and says the page was cut short", async () => {
    routes.set("/big", { body: `<html><body><p>${"padding ".repeat(20_000)}</p></body></html>` });
    const page = await fetchPage(`${origin}/big`, { ...CONFIG, maxBytes: 4096 }, undefined, undefined, allowedHosts);
    expect(page.markdown).toMatch(/Download stopped at 4096 bytes|Showing characters/);
  });
});

describe("safeFetch guards", () => {
  it("blocks loopback, non-http schemes, and IPv6 loopback by default", async () => {
    const opts = { timeoutMs: 2000, maxBytes: 1024 };
    await expect(safeFetch("http://127.0.0.1:1/x", opts)).rejects.toThrow(/Blocked IP/);
    await expect(safeFetch("file:///etc/passwd", opts)).rejects.toThrow(/http and https/);
    await expect(safeFetch("http://[::1]/x", opts)).rejects.toThrow(/Blocked/);
  });

  it("permits a private host the user explicitly allowed", async () => {
    routes.set("/ok", { body: "<html><body><p>allowed</p></body></html>" });
    const response = await safeFetch(`${origin}/ok`, { timeoutMs: 2000, maxBytes: 4096, allowedHosts });
    expect(response.status).toBe(200);
    expect(response.text()).toContain("allowed");
  });

  it("does not extend an allowlisted host to other ports", async () => {
    await expect(
      safeFetch("http://127.0.0.1:9/x", { timeoutMs: 2000, maxBytes: 1024, allowedHosts }),
    ).rejects.toThrow(/Blocked IP/);
  });
});
