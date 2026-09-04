import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.ts";
import { registerQuestions } from "../src/questions/index.ts";
import { registerSubagents } from "../src/subagents/index.ts";
import { registerTodos } from "../src/todos/index.ts";
import { registerWeb } from "../src/web/index.ts";

type Execute = (
  id: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: unknown,
  ctx: Record<string, unknown>,
) => Promise<{ content: Array<{ text: string }>; details?: unknown }>;

/** Collect the tools an extension module registers so they can be invoked directly. */
function collect(register: (pi: never) => void): Map<string, Execute> {
  const tools = new Map<string, Execute>();
  const pi = {
    registerTool: (tool: { name: string; execute: Execute }) => tools.set(tool.name, tool.execute),
    registerCommand: () => undefined,
    registerShortcut: () => undefined,
    on: () => undefined,
    getActiveTools: () => [],
    setActiveTools: () => undefined,
  };
  register(pi as never);
  return tools;
}

function context(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cwd: process.cwd(),
    hasUI: false,
    mode: "print",
    ui: { notify: () => undefined, setWidget: () => undefined },
    sessionManager: { getSessionId: () => "test", getBranch: () => [] },
    isProjectTrusted: () => true,
    ...overrides,
  };
}

const CONFIG = resolveConfig({});

let previousAgentDir: string | undefined;

beforeEach(() => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(os.tmpdir(), "pi-essentials-tools-"));
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

describe("tools raise on failure so pi marks the result isError", () => {
  it("web_search rejects a blank query", async () => {
    const tools = collect((pi) => registerWeb(pi, CONFIG));
    await expect(tools.get("web_search")!("1", { query: "   " }, undefined, undefined, context())).rejects.toThrow(
      /query is required/,
    );
  });

  it("web_fetch rejects missing arguments, bad urls, and unknown cache ids", async () => {
    const tools = collect((pi) => registerWeb(pi, CONFIG));
    const fetchTool = tools.get("web_fetch")!;
    await expect(fetchTool("1", {}, undefined, undefined, context())).rejects.toThrow(/exactly one of url or cacheId/);
    await expect(
      fetchTool("1b", { url: "https://example.com", cacheId: "abc" }, undefined, undefined, context()),
    ).rejects.toThrow(/exactly one of url or cacheId/);
    await expect(fetchTool("1c", { url: "https://example.com", offset: 1.5 }, undefined, undefined, context())).rejects.toThrow(
      /offset must be an integer/,
    );
    await expect(fetchTool("2", { url: "ftp://x.test/a" }, undefined, undefined, context())).rejects.toThrow(
      /http and https/,
    );
    await expect(fetchTool("3", { url: "http://127.0.0.1/x" }, undefined, undefined, context())).rejects.toThrow(
      /blocked for safety/,
    );
    await expect(
      fetchTool("4", { cacheId: "0123456789abcdef" }, undefined, undefined, context()),
    ).rejects.toThrow(/No cached page/);
  });

  it("todo raises on an unknown id but still shows the current list", async () => {
    const tools = collect(registerTodos);
    const todo = tools.get("todo")!;
    const ctx = context();
    await todo("1", { action: "create", content: "Real task" }, undefined, undefined, ctx);
    await expect(todo("2", { action: "complete", id: 99 }, undefined, undefined, ctx)).rejects.toThrow(
      /Todo #99 not found[\s\S]*Real task/,
    );
  });

  it("todo raises on a dependency cycle", async () => {
    const tools = collect(registerTodos);
    const todo = tools.get("todo")!;
    const ctx = context();
    await todo("1", { action: "create", content: "A" }, undefined, undefined, ctx);
    await todo("2", { action: "create", content: "B", blockedBy: [1] }, undefined, undefined, ctx);
    await expect(todo("3", { action: "update", id: 1, blockedBy: [2] }, undefined, undefined, ctx)).rejects.toThrow(
      /cycle/,
    );
  });

  it("todo still returns normally on success", async () => {
    const tools = collect(registerTodos);
    const result = await tools.get("todo")!(
      "1",
      { action: "create", content: "Ship it" },
      undefined,
      undefined,
      context(),
    );
    expect(result.content[0].text).toContain("Created #1");
    expect((result.details as { todos: unknown[] }).todos).toHaveLength(1);
  });

  it("subagent raises for unknown agents without spending the spawn budget", async () => {
    const tools = collect((pi) => registerSubagents(pi, CONFIG));
    const subagent = tools.get("subagent")!;
    await expect(
      subagent("1", { agent: "nope", task: "do a thing" }, undefined, undefined, context()),
    ).rejects.toThrow(/Unknown agent\(s\): nope/);
    // The budget is untouched, so a valid call is still accepted afterwards.
    await expect(subagent("2", { agent: "scout" }, undefined, undefined, context())).rejects.toThrow(
      /exactly one mode|Single mode needs both/,
    );
  });

  it("subagent raises when more parallel tasks are requested than allowed", async () => {
    const tools = collect((pi) => registerSubagents(pi, CONFIG));
    const tasks = Array.from({ length: 20 }, () => ({ agent: "scout", task: "x" }));
    await expect(tools.get("subagent")!("1", { tasks }, undefined, undefined, context())).rejects.toThrow(
      /Too many parallel tasks/,
    );
  });

  it("ask_user_question raises without a UI and on invalid input", async () => {
    const tools = collect(registerQuestions);
    const ask = tools.get("ask_user_question")!;
    await expect(ask("1", { questions: [] }, undefined, undefined, context())).rejects.toThrow(/at least one/);
    await expect(
      ask("2", { questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }] }, undefined, undefined, context()),
    ).rejects.toThrow(/non-interactive/);
  });

  it("ask_user_question returns normally when the user answers", async () => {
    const tools = collect(registerQuestions);
    const ctx = context({
      hasUI: true,
      mode: "tui",
      ui: { select: async (_t: string, labels: string[]) => labels[0], input: async () => "", notify: () => undefined },
    });
    const result = await tools.get("ask_user_question")!(
      "1",
      { questions: [{ question: "Which cache?", options: [{ label: "Redis" }, { label: "None" }] }] },
      undefined,
      undefined,
      ctx,
    );
    expect(result.content[0].text).toContain("A: Redis");
    expect((result.details as { cancelled: boolean }).cancelled).toBe(false);
  });

  it("treats a cancelled questionnaire as an answer, not an error", async () => {
    const tools = collect(registerQuestions);
    const ctx = context({
      hasUI: true,
      mode: "tui",
      ui: { select: async () => undefined, input: async () => undefined, notify: () => undefined },
    });
    const result = await tools.get("ask_user_question")!(
      "1",
      { questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }] },
      undefined,
      undefined,
      ctx,
    );
    expect(result.content[0].text).toMatch(/cancelled/i);
    expect((result.details as { cancelled: boolean }).cancelled).toBe(true);
  });
});
