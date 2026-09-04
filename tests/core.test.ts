import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.ts";
import { loadMcpServers } from "../src/mcp/config.ts";
import { parseMcpArgs } from "../src/mcp/manager.ts";
import { isSecretEnvKey, interpolateEnvValue, sanitizeEnv } from "../src/security/env.ts";
import { assertSafeUrl, isBlockedIp, parseHttpUrl } from "../src/security/ssrf.ts";
import { validateSubagentParams } from "../src/subagents/types.ts";
import { applyTodoMutation, emptyTodoState } from "../src/todos/state.ts";
import { validateQuestions } from "../src/questions/validate.ts";
import { htmlToMarkdown } from "../src/web/html-to-markdown.ts";
import { availableProviders } from "../src/web/search.ts";
import { parseHTML } from "linkedom";
import { extractReadable } from "../src/web/extract.ts";

describe("config", () => {
  it("enables every feature by default", () => {
    const config = resolveConfig({});
    expect(config.mcp.enabled).toBe(true);
    expect(config.web.enabled).toBe(true);
    expect(config.subagents.enabled).toBe(true);
    expect(config.todos.enabled).toBe(true);
    expect(config.questions.enabled).toBe(true);
  });

  it("honors boolean disables and nested options", () => {
    const config = resolveConfig({
      mcp: false,
      web: { enabled: true, search: { provider: "brave", maxResults: 9 } },
      questions: { enabled: false },
    });
    expect(config.mcp.enabled).toBe(false);
    expect(config.web.search.provider).toBe("brave");
    expect(config.web.search.maxResults).toBe(9);
    expect(config.questions.enabled).toBe(false);
  });

  it("clamps invalid numbers and unknown providers", () => {
    const warnings: string[] = [];
    const config = resolveConfig(
      { web: { search: { provider: "nope" as never, maxResults: 99 } }, subagents: { maxConcurrency: 0 } },
      warnings,
    );
    expect(config.web.search.provider).toBe("auto");
    expect(config.web.search.maxResults).toBe(20);
    expect(config.subagents.maxConcurrency).toBe(1);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("ssrf", () => {
  it("rejects non-http schemes and credentials", () => {
    expect(() => parseHttpUrl("file:///etc/passwd")).toThrow(/http/);
    expect(() => parseHttpUrl("https://user:pass@example.com")).toThrow(/credentials/);
  });

  it("blocks private and metadata addresses", () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("10.0.0.2")).toBe(true);
    expect(isBlockedIp("192.168.1.1")).toBe(true);
    expect(isBlockedIp("169.254.169.254")).toBe(true);
    expect(isBlockedIp("100.64.1.1")).toBe(true);
    expect(isBlockedIp("8.8.8.8")).toBe(false);
  });

  it("blocks localhost hostnames before DNS", async () => {
    await expect(assertSafeUrl("http://localhost/secret")).rejects.toThrow(/Blocked host/);
    await expect(assertSafeUrl("http://127.0.0.1/secret")).rejects.toThrow(/Blocked IP/);
  });
});

describe("env sanitization", () => {
  it("drops secret-shaped keys including MCP_*", () => {
    expect(isSecretEnvKey("OPENAI_API_KEY")).toBe(true);
    expect(isSecretEnvKey("GITHUB_TOKEN")).toBe(true);
    expect(isSecretEnvKey("MCP_DOCS_TOKEN")).toBe(true);
    expect(isSecretEnvKey("PATH")).toBe(false);
    const sanitized = sanitizeEnv({
      PATH: "/bin",
      HOME: "/tmp",
      OPENAI_API_KEY: "sk-secret",
      MCP_FOO: "nope",
      LANG: "en_US.UTF-8",
      EDITOR: "vim",
    });
    expect(sanitized.PATH).toBe("/bin");
    expect(sanitized.EDITOR).toBe("vim");
    expect(sanitized.OPENAI_API_KEY).toBeUndefined();
    expect(sanitized.MCP_FOO).toBeUndefined();
  });

  it("interpolates ${VAR} and $env:VAR and reports missing names", () => {
    const missing: string[] = [];
    const value = interpolateEnvValue("Bearer ${TOKEN} $env:OTHER", { TOKEN: "abc", OTHER: "xyz" }, missing);
    expect(value).toBe("Bearer abc xyz");
    expect(missing).toEqual([]);
    const missing2: string[] = [];
    interpolateEnvValue("${MISSING}", {}, missing2);
    expect(missing2).toEqual(["MISSING"]);
  });
});

describe("todos", () => {
  it("creates, updates, completes, and deletes", () => {
    let state = emptyTodoState();
    const created = applyTodoMutation(state, { action: "create", content: "Write tests" });
    state = created.state;
    expect(state.todos[0]?.id).toBe(1);
    state = applyTodoMutation(state, { action: "update", id: 1, status: "in_progress" }).state;
    expect(state.todos[0]?.status).toBe("in_progress");
    state = applyTodoMutation(state, { action: "complete", id: 1 }).state;
    expect(state.todos[0]?.status).toBe("completed");
    state = applyTodoMutation(state, { action: "delete", id: 1 }).state;
    expect(state.todos).toHaveLength(0);
  });

  it("rejects dangling and cyclic blockedBy", () => {
    let state = applyTodoMutation(emptyTodoState(), { action: "create", content: "A" }).state;
    expect(() => applyTodoMutation(state, { action: "create", content: "B", blockedBy: [99] })).toThrow(/missing/);
    state = applyTodoMutation(state, { action: "create", content: "B", blockedBy: [1] }).state;
    expect(() => applyTodoMutation(state, { action: "update", id: 1, blockedBy: [2] })).toThrow(/cycle/);
  });
});

describe("questions", () => {
  it("enforces 1-4 questions and 2-4 options", () => {
    expect(validateQuestions([])).toMatch(/at least one/i);
    expect(
      validateQuestions([{ question: "Pick?", options: [{ label: "A" }] }]),
    ).toMatch(/at least 2/);
    expect(
      validateQuestions([
        {
          question: "Pick?",
          options: [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }, { label: "E" }],
        },
      ]),
    ).toMatch(/more than 4/);
    expect(validateQuestions([{ question: "Pick?", options: [{ label: "A" }, { label: "B" }] }])).toBeUndefined();
  });
});

describe("subagent params", () => {
  it("requires exactly one mode", () => {
    expect(validateSubagentParams({})).toEqual(expect.objectContaining({ error: expect.any(String) }));
    expect(validateSubagentParams({ agent: "scout", task: "look around" })).toEqual({ mode: "single" });
    expect(validateSubagentParams({ tasks: [{ agent: "scout", task: "a" }] })).toEqual({ mode: "parallel" });
    expect(validateSubagentParams({ chain: [{ agent: "scout", task: "a" }] })).toEqual({ mode: "chain" });
    expect(validateSubagentParams({ agent: "scout", task: "x", tasks: [{ agent: "scout", task: "y" }] })).toEqual(
      expect.objectContaining({ error: expect.any(String) }),
    );
  });
});

describe("web extraction", () => {
  it("converts simple HTML to markdown", () => {
    const { document } = parseHTML("<h1>Hello</h1><p>This is <strong>bold</strong> and <a href='https://x.test'>a link</a>.</p>");
    const md = htmlToMarkdown(document);
    expect(md).toContain("# Hello");
    expect(md).toContain("**bold**");
    expect(md).toContain("[a link](https://x.test)");
  });

  it("extracts readable article text instead of dumping chrome", () => {
    const html = `<html><head><title>Doc</title></head><body>
      <nav>ignore me</nav>
      <article><h1>Install</h1><p>Run npm install and restart Pi.</p></article>
    </body></html>`;
    const extracted = extractReadable(html, "https://example.com/doc");
    expect(extracted.markdown.toLowerCase()).toContain("install");
    expect(extracted.markdown.length).toBeLessThan(html.length + 50);
  });

  it("lists search providers from available keys", () => {
    const names = availableProviders({
      provider: "auto",
      braveApiKey: "x",
      timeoutMs: 1000,
      maxResults: 5,
    });
    expect(names).toContain("brave");
    expect(names.at(-1)).toBe("duckduckgo");
  });
});

describe("mcp helpers", () => {
  it("parses object and JSON-string args and rejects malformed payloads", () => {
    expect(parseMcpArgs({ a: 1 })).toEqual({ a: 1 });
    expect(parseMcpArgs('{"a":2}')).toEqual({ a: 2 });
    expect(parseMcpArgs("")).toEqual({});
    expect(() => parseMcpArgs("not-json")).toThrow(/valid JSON/);
    expect(() => parseMcpArgs("[1]")).toThrow(/object/);
  });

  it("loads MCP servers from a file-shaped directory via candidates override", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pi-essentials-mcp-"));
    writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { demo: { command: "echo", args: ["hi"] } } }));
    const original = process.cwd();
    process.chdir(dir);
    try {
      const { servers } = loadMcpServers(dir);
      expect(servers.some((s) => s.name === "demo")).toBe(true);
    } finally {
      process.chdir(original);
    }
  });
});
