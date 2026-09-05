import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergeFiles, resolveConfig } from "../src/config.ts";
import { capBytes, isAbortError } from "../src/errors.ts";
import { MAX_TODOS } from "../src/security/limits.ts";
import { discoverAgents } from "../src/subagents/discover.ts";
import { parseAgentMarkdown } from "../src/subagents/types.ts";
import { applySessionEvent, emptyTrace, summarizeTool, summarizeToolArgs } from "../src/subagents/activity.ts";
import {
  accumulateUsage,
  buildArgs,
  buildResultExtension,
  emptyUsage,
  finalAssistantText,
  mapLimit,
  resolveOnPath,
} from "../src/subagents/runner.ts";
import { displayOptions } from "../src/questions/ask.ts";
import { formatAnswers } from "../src/questions/validate.ts";
import { sliceMarkdown } from "../src/web/cache.ts";
import { charsetFromContentType, decodeBody } from "../src/web/http.ts";
import { decodeDdgUrl } from "../src/web/providers/duckduckgo.ts";
import { loadMcpServers } from "../src/mcp/config.ts";
import { __testing as mcpTesting, parseMcpArgs } from "../src/mcp/manager.ts";
import {
  isProviderCredentialEnvKey,
  isSecretEnvKey,
  interpolateEnvValue,
  sanitizeEnv,
} from "../src/security/env.ts";
import { assertSafeUrl, expandIpv6, isBlockedHostname, isBlockedIp, parseHttpUrl } from "../src/security/ssrf.ts";
import { effectiveOutputSchema, validateOutputSchema } from "../src/subagents/schema.ts";
import { validateSubagentParams } from "../src/subagents/types.ts";
import { parseChangedFiles } from "../src/subagents/worktree.ts";
import { applyTodoMutation, emptyTodoState } from "../src/todos/state.ts";
import { validateQuestions } from "../src/questions/validate.ts";
import { htmlToMarkdown } from "../src/web/html-to-markdown.ts";
import { availableProviders } from "../src/web/search.ts";
import { parseHTML } from "linkedom";
import { extractReadable, extractTitle } from "../src/web/extract.ts";

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
    expect(isBlockedIp("172.16.0.1")).toBe(true);
    expect(isBlockedIp("172.32.0.1")).toBe(false);
    expect(isBlockedIp("8.8.8.8")).toBe(false);
  });

  it("blocks every textual form of IPv6 loopback and private space", () => {
    expect(isBlockedIp("::1")).toBe(true);
    expect(isBlockedIp("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isBlockedIp("::")).toBe(true);
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIp("::ffff:7f00:1")).toBe(true);
    expect(isBlockedIp("fe80::1")).toBe(true);
    expect(isBlockedIp("FD00::1")).toBe(true);
    expect(isBlockedIp("ff02::1")).toBe(true);
    expect(isBlockedIp("64:ff9b::1.2.3.4")).toBe(true);
    expect(isBlockedIp("2001:4860:4860::8888")).toBe(false);
    expect(isBlockedIp("not-an-ip")).toBe(true);
  });

  it("expands compressed IPv6 into eight groups", () => {
    expect(expandIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6("2001:db8::8:800:200c:417a")).toEqual([0x2001, 0xdb8, 0, 0, 8, 0x800, 0x200c, 0x417a]);
    expect(expandIpv6("nope")).toBeUndefined();
  });

  it("normalizes bracketed and trailing-dot hostnames", () => {
    expect(isBlockedHostname("[::1]")).toBe(true);
    expect(isBlockedHostname("localhost.")).toBe(true);
    expect(isBlockedHostname("METADATA.GOOGLE.INTERNAL")).toBe(true);
    expect(isBlockedHostname("printer.lan")).toBe(true);
    expect(isBlockedHostname("example.com")).toBe(false);
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
      GITHUB_TOKEN: "ghp_secret",
      STRIPE_API_KEY: "sk_live",
      MCP_FOO: "nope",
      LANG: "en_US.UTF-8",
      EDITOR: "vim",
    });
    expect(sanitized.PATH).toBe("/bin");
    expect(sanitized.EDITOR).toBe("vim");
    expect(sanitized.GITHUB_TOKEN).toBeUndefined();
    expect(sanitized.STRIPE_API_KEY).toBeUndefined();
    expect(sanitized.MCP_FOO).toBeUndefined();
  });

  it("keeps model-provider credentials so a child pi can authenticate", () => {
    expect(isProviderCredentialEnvKey("ANTHROPIC_API_KEY")).toBe(true);
    expect(isProviderCredentialEnvKey("MCP_DOCS_TOKEN")).toBe(false);
    const sanitized = sanitizeEnv({
      ANTHROPIC_API_KEY: "sk-ant",
      OPENAI_API_KEY: "sk-openai",
      GEMINI_API_KEY: "gem",
      STRIPE_API_KEY: "sk_live",
    });
    expect(sanitized.ANTHROPIC_API_KEY).toBe("sk-ant");
    expect(sanitized.OPENAI_API_KEY).toBe("sk-openai");
    expect(sanitized.GEMINI_API_KEY).toBe("gem");
    expect(sanitized.STRIPE_API_KEY).toBeUndefined();
  });

  it("can opt out of forwarding provider credentials", () => {
    const sanitized = sanitizeEnv({ ANTHROPIC_API_KEY: "sk-ant" }, {}, { keepProviderCredentials: false });
    expect(sanitized.ANTHROPIC_API_KEY).toBeUndefined();
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

describe("config merging", () => {
  it("deep-merges nested feature options instead of replacing them", () => {
    const merged = mergeFiles(
      { web: { search: { braveApiKey: "user-key", maxResults: 3 } }, mcp: { requestTimeoutMs: 5000 } },
      { web: { search: { maxResults: 7 } }, mcp: { idleTimeoutMs: 9000 } },
    );
    const config = resolveConfig(merged);
    expect(config.web.search.braveApiKey).toBe("user-key");
    expect(config.web.search.maxResults).toBe(7);
    expect(config.mcp.requestTimeoutMs).toBe(5000);
    expect(config.mcp.idleTimeoutMs).toBe(9000);
  });

  it("lets a later file switch a feature off entirely", () => {
    const merged = mergeFiles({ subagents: { maxConcurrency: 2 } }, { subagents: false });
    expect(resolveConfig(merged).subagents.enabled).toBe(false);
  });
});

describe("html to markdown", () => {
  const render = (html: string) => htmlToMarkdown(parseHTML(html).document);

  it("keeps sibling blocks apart instead of running them together", () => {
    expect(render("<div>First</div><div>Second</div>")).toBe("First\n\nSecond");
  });

  it("numbers ordered lists and indents nested ones", () => {
    const md = render("<ol start='3'><li>Alpha<ul><li>inner</li></ul></li><li>Beta</li></ol>");
    expect(md).toContain("3. Alpha");
    expect(md).toContain("  - inner");
    expect(md).toContain("4. Beta");
  });

  it("renders tables as markdown tables", () => {
    const md = render("<table><tr><th>Name</th><th>N</th></tr><tr><td>a</td><td>1</td></tr></table>");
    expect(md).toContain("| Name | N |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| a | 1 |");
  });

  it("labels fenced code with its language and skips scripts", () => {
    const md = render("<pre><code class='language-ts'>const a = 1;</code></pre><script>evil()</script>");
    expect(md).toContain("```ts");
    expect(md).not.toContain("evil");
  });

  it("drops javascript: links but keeps their text", () => {
    expect(render("<p><a href='javascript:alert(1)'>click</a></p>")).toBe("click");
  });
});

describe("web cache slicing", () => {
  it("clamps offsets and reports the window", () => {
    expect(sliceMarkdown("abcdef", 2, 3)).toEqual({ text: "cde", total: 6, start: 2 });
    expect(sliceMarkdown("abcdef", -5, 2)).toEqual({ text: "ab", total: 6, start: 0 });
    expect(sliceMarkdown("abcdef", 99)).toEqual({ text: "", total: 6, start: 6 });
  });
});

describe("http helpers", () => {
  it("reads the charset from the content type", () => {
    expect(charsetFromContentType('text/html; charset="ISO-8859-1"')).toBe("iso-8859-1");
    expect(charsetFromContentType("text/html")).toBe("utf-8");
  });

  it("decodes latin-1 bytes without mojibake and falls back on unknown labels", () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    expect(decodeBody(latin1, "iso-8859-1")).toBe("café");
    expect(decodeBody(new Uint8Array([0x68, 0x69]), "not-a-charset")).toBe("hi");
  });
});

describe("agent definitions", () => {
  it("parses frontmatter lists in inline and block form", () => {
    const inline = parseAgentMarkdown("---\nname: a\ntools: [read, grep]\n---\nBody", "fallback", "user");
    expect(inline.tools).toEqual(["read", "grep"]);
    const block = parseAgentMarkdown("---\nname: b\ntools:\n  - read\n  - grep\n---\nBody", "fallback", "user");
    expect(block.tools).toEqual(["read", "grep"]);
    const csv = parseAgentMarkdown("---\ntools: read, grep\n---\nBody", "fallback", "user");
    expect(csv.tools).toEqual(["read", "grep"]);
    expect(csv.name).toBe("fallback");
  });

  it("sanitizes agent names and keeps the body as the system prompt", () => {
    const agent = parseAgentMarkdown("---\nname: ../../evil name\n---\n  Prompt body  ", "fallback", "project");
    expect(agent.name).toBe("evil-name");
    expect(agent.systemPrompt).toBe("Prompt body");
  });

  it("ships the documented builtin agents", () => {
    const names = discoverAgents(process.cwd(), "user").map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining(["scout", "reviewer", "worker", "oracle"]));
  });
});

describe("subagent runner", () => {
  it("builds pi arguments and terminates flag parsing before the task", () => {
    const args = buildArgs({
      agent: { name: "scout", description: "", systemPrompt: "x", source: "builtin", tools: ["read", "grep"] },
      model: "anthropic/claude",
      thinkingLevel: "high",
      promptFile: "/tmp/scout.md",
      task: "-look around",
    });
    expect(args.slice(0, 3)).toEqual(["--mode", "json", "--no-session"]);
    expect(args).toContain("--no-session");
    expect(args).toEqual(expect.arrayContaining(["--model", "anthropic/claude", "--thinking", "high"]));
    expect(args).toEqual(expect.arrayContaining(["--tools", "read,grep"]));
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe("Task: -look around");
  });

  it("adds a temporary structured-result extension and preserves a tool allowlist", () => {
    const args = buildArgs({
      agent: { name: "a", description: "", systemPrompt: "", source: "builtin", tools: ["read"] },
      extensionFile: "/tmp/result.ts",
      structured: true,
      task: "t",
    });
    expect(args).toEqual(expect.arrayContaining(["--extension", "/tmp/result.ts", "--tools", "read,subagent_result"]));
    const source = buildResultExtension({ type: "object", properties: { answer: { type: "string" } } });
    expect(source).toContain('name: "subagent_result"');
    expect(source).toContain("parameters: schema");
    expect(source).toContain("terminate: true");
  });

  it("prefers the agent's own model over the parent's", () => {
    const args = buildArgs({
      agent: { name: "a", description: "", systemPrompt: "", source: "builtin", model: "openai/gpt" },
      model: "anthropic/claude",
      task: "t",
    });
    expect(args).toEqual(expect.arrayContaining(["--model", "openai/gpt"]));
    expect(args).not.toContain("anthropic/claude");
  });

  it("reads cost from usage.cost.total the way pi reports it", () => {
    const usage = emptyUsage();
    accumulateUsage(usage, {
      input: 10,
      output: 4,
      cacheRead: 2,
      cost: { input: 0.1, output: 0.15, cacheRead: 0.01, total: 0.25 },
    });
    accumulateUsage(usage, { input: 1, cost: { input: 0.2, total: 0.75 } });
    accumulateUsage(usage, undefined);
    expect(usage).toMatchObject({
      input: 11,
      output: 4,
      cacheRead: 2,
      cost: 1,
      costOutput: 0.15,
      costCacheRead: 0.01,
    });
    expect(usage.costInput).toBeCloseTo(0.3);
  });

  it("returns the last assistant text block as the answer", () => {
    const text = finalAssistantText([
      { role: "assistant", content: [{ type: "text", text: "first" }] },
      { role: "toolResult", content: [{ type: "text", text: "ignored" }] },
      { role: "assistant", content: [{ type: "text", text: "final" }] },
    ]);
    expect(text).toBe("final");
  });

  it("runs mapLimit tasks in order with bounded concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("subagent live activity", () => {
  it("summarizes tool args and strips secret-shaped fields", () => {
    expect(summarizeTool("read", { path: "src/auth.ts" })).toBe("read · src/auth.ts");
    expect(summarizeToolArgs({ apiKey: "sk-secret", token: "abc", command: "git log" })).toBe("git log");
    expect(summarizeToolArgs({ password: "nope" })).toBeUndefined();
  });

  it("folds json-mode tool and text events into a live trace", () => {
    const trace = emptyTrace();
    expect(applySessionEvent(trace, { type: "tool_execution_start", toolName: "bash", args: { command: "git log" } })).toBe(true);
    expect(trace.activity).toBe("bash · git log");
    expect(trace.events.at(-1)).toEqual({ kind: "tool", name: "bash", args: "git log", status: "running" });

    applySessionEvent(trace, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "The payment " },
    });
    applySessionEvent(trace, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "flow starts in checkout." },
    });
    expect(trace.activity).toContain("payment");
    applySessionEvent(trace, { type: "message_end", message: { role: "assistant", content: [] } });
    expect(trace.events.at(-1)).toMatchObject({ kind: "text", text: expect.stringContaining("payment") });

    applySessionEvent(trace, { type: "tool_execution_end", toolName: "bash", isError: true });
    expect(trace.events.find((event) => event.kind === "tool" && event.name === "bash")).toMatchObject({ status: "error" });
    expect(trace.activity).toBe("bash failed");
  });
});

describe("structured subagent schemas", () => {
  const root = { type: "object", properties: { root: { type: "boolean" } } };
  const task = { type: "object", properties: { task: { type: "string" } } };

  it("accepts bounded object schemas and lets task schemas override the root", () => {
    expect(validateOutputSchema(root)).toEqual(root);
    expect(effectiveOutputSchema(undefined, root)).toEqual(root);
    expect(effectiveOutputSchema(task, root)).toEqual(task);
  });

  it("rejects non-object outputs, dangerous keys, and excessive depth", () => {
    expect(() => validateOutputSchema({ type: "array", items: { type: "string" } })).toThrow(/object at its root/);
    expect(() => validateOutputSchema(JSON.parse('{"type":"object","__proto__":{}}'))).toThrow(/unsafe key/);
    expect(() => validateOutputSchema({ type: "object", required: "name" })).toThrow(/required/);
    expect(() => validateOutputSchema({ type: "object", properties: [] })).toThrow(/properties/);
    expect(() => validateOutputSchema({ type: "object", properties: { x: 42 } })).toThrow(/properties\.x/);
    expect(() => validateOutputSchema({ type: "object", allOf: ["bad"] })).toThrow(/allOf/);
    expect(validateOutputSchema({ type: "object", properties: { type: { type: "string" } } })).toBeTruthy();
    let deep: Record<string, unknown> = { type: "object" };
    const schema = deep;
    for (let i = 0; i < 20; i++) deep = (deep.next = {}) as Record<string, unknown>;
    expect(() => validateOutputSchema(schema)).toThrow(/maximum depth/);
  });

  it("parses changed and renamed files from porcelain -z output", () => {
    expect(parseChangedFiles(" M src/a.ts\0?? new file.txt\0R  dst.ts\0src.ts\0")).toEqual([
      "dst.ts", "new file.txt", "src.ts", "src/a.ts",
    ]);
  });
});

describe("questions", () => {
  it("numbers options so selections map back by index", () => {
    const labels = displayOptions([{ label: "Redis", description: "Shared" }, { label: "None" }]);
    expect(labels).toEqual(["1. Redis — Shared", "2. None"]);
  });

  it("rejects duplicate option labels", () => {
    expect(validateQuestions([{ question: "Pick?", options: [{ label: "A" }, { label: "a" }] }])).toMatch(/distinct/);
  });

  it("formats answers with header and custom text", () => {
    const text = formatAnswers(
      [{ question: "Which?", header: "Cache", selected: ["Redis"], custom: "or memcached" }],
      false,
    );
    expect(text).toContain("[Cache] Which?");
    expect(text).toContain("Redis | wrote: or memcached");
  });

  it("reports partial answers when the user cancels midway", () => {
    const text = formatAnswers([{ question: "Q1", selected: ["A"] }], true);
    expect(text).toContain("A: A");
    expect(text).toContain("cancelled the remaining");
  });
});

describe("todo dependencies", () => {
  it("warns when starting a blocked todo and reports unblocking", () => {
    let state = applyTodoMutation(emptyTodoState(), { action: "create", content: "A" }).state;
    state = applyTodoMutation(state, { action: "create", content: "B", blockedBy: [1] }).state;

    const started = applyTodoMutation(state, { action: "update", id: 2, status: "in_progress" });
    expect(started.message).toMatch(/still blocked by #1/);

    const done = applyTodoMutation(started.state, { action: "complete", id: 1 });
    expect(done.message).toMatch(/Unblocked: #2/);
    expect(applyTodoMutation(done.state, { action: "complete", id: 1 }).message).toMatch(/already completed/);
  });

  it("moves the previous todo back to pending when another starts", () => {
    let state = applyTodoMutation(emptyTodoState(), { action: "create", content: "A", status: "in_progress" }).state;
    const second = applyTodoMutation(state, { action: "create", content: "B", status: "in_progress" });
    expect(second.message).toMatch(/#1.*back to pending/);
    state = second.state;
    expect(state.todos.filter((t) => t.status === "in_progress")).toHaveLength(1);
    expect(state.todos.find((t) => t.id === 1)?.status).toBe("pending");
  });

  it("enforces the maximum todo count", () => {
    let state = emptyTodoState();
    for (let i = 0; i < MAX_TODOS; i++) {
      state = applyTodoMutation(state, { action: "create", content: `T${i}` }).state;
    }
    expect(() => applyTodoMutation(state, { action: "create", content: "overflow" })).toThrow(/40 total/);
  });
});

describe("mcp config", () => {
  it("rejects half-specified servers and reads shared settings", () => {
    // loadMcpServers also reads real home-relative files (~/.config/mcp/mcp.json,
    // ~/.agents/mcp.json, ~/.pi/agent/mcp.json); isolate HOME so a developer's own
    // MCP config can't leak an extra server into this assertion.
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), "pi-essentials-fake-home-"));
    const previousHome = process.env.HOME;
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = fakeHome;
    delete process.env.PI_CODING_AGENT_DIR;
    try {
      const dir = mkdtempSync(path.join(os.tmpdir(), "pi-essentials-mcp2-"));
      writeFileSync(
        path.join(dir, ".mcp.json"),
        JSON.stringify({
          settings: { requestTimeoutMs: 4321, idleTimeout: 7 },
          mcpServers: {
            good: { command: "echo" },
            empty: {},
            both: { command: "echo", url: "https://example.com" },
            badArgs: { command: "echo", args: "not-an-array" },
            badTimeout: { command: "echo", requestTimeoutMs: -1 },
            badHeaders: { url: "https://example.com", headers: { authorization: 42 } },
            badProtocol: { url: "file:///tmp/server" },
          },
        }),
      );
      const { servers, warnings, settings } = loadMcpServers(dir);
      expect(servers.map((s) => s.name)).toEqual(["good"]);
      expect(settings).toEqual({ requestTimeoutMs: 4321, idleTimeout: 7 });
      expect(warnings.join(" ")).toMatch(/empty/);
      expect(warnings.join(" ")).toMatch(/both/);
      expect(warnings.join(" ")).toMatch(/badArgs/);
      expect(warnings.join(" ")).toMatch(/badTimeout/);
      expect(warnings.join(" ")).toMatch(/badHeaders/);
      expect(warnings.join(" ")).toMatch(/badProtocol/);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});

describe("duckduckgo parsing", () => {
  it("unwraps redirect links", () => {
    expect(decodeDdgUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa")).toBe("https://example.com/a");
    expect(decodeDdgUrl("https://example.com/b")).toBe("https://example.com/b");
  });
});

describe("abort detection", () => {
  it("does not mistake an upstream gateway timeout for a local cancellation", () => {
    expect(isAbortError(new Error("HTTP 504 fetching https://x.test: Gateway timed out"))).toBe(false);
    expect(isAbortError(new Error("Fetch was cancelled or timed out."))).toBe(true);
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    expect(isAbortError(abort)).toBe(true);
  });
});


describe("mcp tool results", () => {
  const { stringifyToolResult, httpStatus } = mcpTesting;

  it("never inlines base64 image or audio payloads", () => {
    const text = stringifyToolResult({
      content: [
        { type: "text", text: "Screenshot taken." },
        { type: "image", data: "A".repeat(400_000), mimeType: "image/png" },
      ],
    });
    expect(text).toContain("Screenshot taken.");
    expect(text).not.toContain("AAAA");
    expect(text).toMatch(/image content omitted: image\/png, ~\d+ KB base64/);
  });

  it("unwraps embedded text resources and labels binary ones", () => {
    expect(
      stringifyToolResult({ content: [{ type: "resource", resource: { uri: "file:///a", text: "hello" } }] }),
    ).toBe("hello");
    expect(
      stringifyToolResult({ content: [{ type: "resource", resource: { uri: "file:///a", blob: "AAA", mimeType: "application/pdf" } }] }),
    ).toContain("resource omitted: file:///a");
  });

  it("preserves structuredContent beside text without duplicating mirrored JSON", () => {
    const combined = stringifyToolResult({
      content: [{ type: "text", text: "Human-readable result" }],
      structuredContent: { ok: true },
    });
    expect(combined).toContain("Human-readable result");
    expect(combined).toContain('"ok": true');

    const mirrored = stringifyToolResult({
      content: [{ type: "text", text: '{"ok":true}' }],
      structuredContent: { ok: true },
    });
    expect(mirrored.match(/"ok"/g)).toHaveLength(1);
    expect(stringifyToolResult({ content: [] })).toBe("(empty MCP result)");
  });

  it("classifies MCP isError results as tool failures", () => {
    const failure = mcpTesting.mcpResultError({ content: [{ type: "text", text: "remote failure" }], isError: true });
    expect(failure).toMatchObject({ code: "MCP_TOOL_ERROR", message: "remote failure" });
    expect(mcpTesting.mcpResultError({ content: [], isError: false })).toBeUndefined();
  });

  it("requires a prefixed route for ambiguous unprefixed MCP names", () => {
    const tools = [
      { server: "one", name: "read", prefixedName: "one_read", description: "" },
      { server: "two", name: "read", prefixedName: "two_read", description: "" },
    ];
    expect(() => mcpTesting.resolveTool(tools, "read")).toThrow(/Ambiguous.*one_read, two_read/);
    expect(mcpTesting.resolveTool(tools, "two_read")?.server).toBe("two");
  });

  it("only reads a status code when the message is phrased like one", () => {
    expect(httpStatus(new Error("HTTP 405 Method Not Allowed"))).toBe(405);
    expect(httpStatus(new Error("status: 404"))).toBe(404);
    expect(httpStatus(new Error("issue 404 in the tracker is unrelated"))).toBeUndefined();
    expect(httpStatus({ status: 415 })).toBe(415);
  });
});

describe("pi executable resolution", () => {
  it("finds an executable on PATH without shelling out", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pi-essentials-path-"));
    writeFileSync(path.join(dir, "fake-pi"), "#!/bin/sh\n");
    expect(resolveOnPath("fake-pi", { PATH: dir })).toBe(path.join(dir, "fake-pi"));
    expect(resolveOnPath("definitely-missing", { PATH: dir })).toBeUndefined();
    expect(resolveOnPath("fake-pi", {})).toBeUndefined();
  });
});

describe("byte-accurate truncation", () => {
  it("leaves short text alone", () => {
    expect(capBytes("hello", 100)).toEqual({ text: "hello", truncated: false });
  });

  it("measures bytes, not characters", () => {
    // 40 two-byte characters = 80 bytes, well over a 50-byte budget even though
    // the string is only 40 characters long.
    const text = "é".repeat(40);
    expect(text.length).toBe(40);
    expect(Buffer.byteLength(text, "utf8")).toBe(80);
    const capped = capBytes(text, 50);
    expect(capped.truncated).toBe(true);
    expect(Buffer.byteLength(capped.text, "utf8")).toBeLessThanOrEqual(50);
  });

  it("never splits a multi-byte character", () => {
    for (let budget = 16; budget < 40; budget++) {
      const capped = capBytes("🎈".repeat(20), budget);
      const kept = capped.text.split("\n\n[Truncated")[0];
      expect(kept).not.toContain("�");
      expect([...kept].every((char) => char === "🎈")).toBe(true);
    }
  });

  it("reports how much was dropped", () => {
    const capped = capBytes("a".repeat(1000), 100);
    expect(capped.text).toMatch(/\[Truncated: \d+ of 1000 bytes omitted\.\]/);
  });
});

describe("allowed hosts config", () => {
  it("trusts a configured searxng instance without extra setup", () => {
    const config = resolveConfig({ web: { search: { searxngUrl: "http://localhost:8888" } } });
    expect(config.web.allowedHosts.has("localhost:8888")).toBe(true);
  });

  it("accepts explicit entries and warns about unusable ones", () => {
    const warnings: string[] = [];
    const config = resolveConfig({ web: { allowedHosts: ["10.0.0.5:9000", "  ", "http://box.lan"] } }, warnings);
    expect(config.web.allowedHosts.has("10.0.0.5:9000")).toBe(true);
    expect(config.web.allowedHosts.has("box.lan")).toBe(true);
    expect(warnings.some((w) => w.includes("Ignoring unparseable"))).toBe(true);
  });

  it("rejects a non-array allowedHosts value", () => {
    const warnings: string[] = [];
    resolveConfig({ web: { allowedHosts: "localhost" as never } }, warnings);
    expect(warnings.some((w) => w.includes("must be an array"))).toBe(true);
  });

  it("defaults to trusting nothing private", () => {
    expect(resolveConfig({}).web.allowedHosts.size).toBe(0);
  });
});

describe("page titles", () => {
  const doc = (html: string) => parseHTML(html).document;

  it("reads the title element even when document.title is unreliable", () => {
    // linkedom returns "" from document.title on some real pages, so the
    // extractor must query the element instead of trusting the getter.
    const document = doc("<html><head><title>  Stream | Node.js  </title></head><body>x</body></html>");
    expect(extractTitle(document)).toBe("Stream | Node.js");
  });

  it("falls back through og:title, twitter:title, and the first h1", () => {
    expect(extractTitle(doc('<html><head><meta property="og:title" content="OG"></head><body></body></html>'))).toBe("OG");
    expect(
      extractTitle(doc('<html><head><meta name="twitter:title" content="TW"></head><body></body></html>')),
    ).toBe("TW");
    expect(extractTitle(doc("<html><body><h1>Heading</h1></body></html>"))).toBe("Heading");
    expect(extractTitle(doc("<html><body><p>no title</p></body></html>"))).toBe("");
  });

  it("uses the url only when the page offers no title at all", () => {
    const withTitle = extractReadable("<html><head><title>Real</title></head><body><p>hi</p></body></html>", "https://x.test/a");
    expect(withTitle.title).toBe("Real");
    const without = extractReadable("<html><body><p>hi</p></body></html>", "https://x.test/a");
    expect(without.title).toBe("https://x.test/a");
  });
});
