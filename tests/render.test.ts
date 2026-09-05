import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { ActivityLog, activityWidget } from "../src/web/activity.ts";
import { mcpStatusText, renderMcpCall, renderMcpResult } from "../src/mcp/render.ts";
import { renderAskCall, renderAskResult } from "../src/questions/render.ts";
import { conversationLines, fleetLayout, fleetWidget, hitTestFleet, inspectorFrame, rosterLines, renderSubagentCall, renderSubagentResult, renderTraceEvent } from "../src/subagents/render.ts";
import { formatTodosGrouped, renderTodoCall, renderTodoResult, todoWidget } from "../src/todos/render.ts";
import { renderFetchCall, renderFetchResult, renderSearchCall, renderSearchResult } from "../src/web/render.ts";
import { formatCost, formatDuration, oneLine, plural, progressBar, shortUrl } from "../src/ui/render.ts";
import type { TodoItem } from "../src/todos/state.ts";

/** Identity theme: renderers are asserted on their plain text, not ANSI codes. */
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  inverse: (text: string) => text,
  strikethrough: (text: string) => `~${text}~`,
} as unknown as Theme;

const slot = () => ({ lastComponent: undefined, isError: false });
const errSlot = () => ({ lastComponent: undefined, isError: true });
const view = (component: { render(width: number): string[] }) =>
  component
    .render(120)
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n");

const TODOS: TodoItem[] = [
  { id: 1, content: "Read the docs", status: "completed" },
  { id: 2, content: "Add pinning", status: "completed" },
  { id: 3, content: "Wire the panel", status: "in_progress" },
  { id: 4, content: "Update the README", status: "pending", blockedBy: [3] },
];

describe("formatting primitives", () => {
  it("formats durations across magnitudes", () => {
    expect(formatDuration(340)).toBe("340ms");
    expect(formatDuration(2100)).toBe("2.1s");
    expect(formatDuration(95_000)).toBe("1m35s");
    expect(formatDuration(-1)).toBe("0s");
  });

  it("keeps sub-cent costs meaningful and hides zero", () => {
    expect(formatCost(0)).toBeUndefined();
    expect(formatCost(-1)).toBeUndefined();
    expect(formatCost(0.00031)).toBe("$0.00031");
    expect(formatCost(0.031)).toBe("$0.031");
    expect(formatCost(1.239)).toBe("$1.24");
  });

  it("pluralizes counts", () => {
    expect(plural(1, "turn")).toBe("1 turn");
    expect(plural(3, "turn")).toBe("3 turns");
  });

  it("shortens urls to host plus path", () => {
    expect(shortUrl("https://nodejs.org/api/stream.html")).toBe("nodejs.org/api/stream.html");
    expect(shortUrl("https://example.com/")).toBe("example.com");
    expect(shortUrl("not a url")).toBe("not a url");
  });

  it("truncates single-line previews with an ellipsis", () => {
    expect(oneLine("a  b\n c", 40)).toBe("a b c");
    expect(oneLine("x".repeat(20), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("draws a proportional progress meter", () => {
    expect(progressBar(theme, 0, 4, 4)).toBe("▫▫▫▫");
    expect(progressBar(theme, 2, 4, 4)).toBe("▪▪▫▫");
    expect(progressBar(theme, 4, 4, 4)).toBe("▪▪▪▪");
    expect(progressBar(theme, 1, 0, 4)).toBe("");
  });
});

describe("web rendering", () => {
  it("summarizes a search and hides the tail behind the expand key", () => {
    const hits = Array.from({ length: 5 }, (_, i) => ({
      title: `Result ${i + 1}`,
      url: `https://example.com/${i}`,
      snippet: "",
      source: "brave",
    }));
    const out = view(
      renderSearchResult({ content: [], details: { provider: "brave", hits } }, { expanded: false, isPartial: false }, theme, slot()),
    );
    expect(out).toContain("✓ 5 results");
    expect(out).not.toContain("brave");
    expect(out).toContain("1. Result 1");
    expect(out).toContain("+2 more results · ctrl+o to expand");
    expect(out).not.toContain("Result 5");

    const expanded = view(
      renderSearchResult({ content: [], details: { provider: "brave", hits } }, { expanded: true, isPartial: false }, theme, slot()),
    );
    expect(expanded).toContain("Result 5");
    expect(expanded).not.toContain("to expand");
  });

  it("marks an empty search as such rather than as success", () => {
    const out = view(
      renderSearchResult({ content: [], details: { provider: "ddg", hits: [] } }, { expanded: false, isPartial: false }, theme, slot()),
    );
    expect(out).toContain("no results");
    expect(out).not.toContain("✓");
  });

  it("shows the page title and cache id, not the raw preamble", () => {
    const text = "# Guide\nSource: https://x.test/g\nCache-Id: abc123\n\nFirst body line.\nSecond body line.";
    const out = view(
      renderFetchResult(
        {
          content: [{ type: "text", text }],
          details: { url: "https://x.test/g", title: "Guide", totalChars: 4200, truncated: true, cacheId: "abc123" },
        },
        { expanded: false, isPartial: false },
        theme,
        slot(),
      ),
    );
    expect(out).toContain("✓ Guide · 4.2k chars · truncated · id abc123");
    expect(out).toContain("First body line.");
    expect(out).not.toContain("Cache-Id:");
  });

  it("renders call headers and error states", () => {
    expect(view(renderSearchCall({ query: "streams", numResults: 5 }, theme, slot()))).toBe(
      'web_search "streams" · 5 results',
    );
    expect(view(renderFetchCall({ url: "https://x.test/a/b" }, theme, slot()))).toBe("web_fetch x.test/a/b");
    expect(view(renderFetchCall({ cacheId: "abc" }, theme, slot()))).toBe("web_fetch cache abc");
    expect(view(renderFetchResult({ content: [{ type: "text", text: "Blocked host" }] }, { expanded: false, isPartial: false }, theme, errSlot()))).toBe(
      "✗ Blocked host",
    );
  });

  it("logs activity rows with outcome and timing", async () => {
    const log = new ActivityLog();
    await log.track("search", "streams", async () => ({ hits: [1, 2] }), (r) => `${r.hits.length} hits`);
    await expect(
      log.track("fetch", "https://x.test/gone", async () => { throw new Error("HTTP 404 fetching"); }, () => ""),
    ).rejects.toThrow();

    expect(log.size).toBe(2);
    const out = activityWidget(theme, log, { collapsed: false, maxRows: 6 }).join("\n");
    // Newest first.
    expect(out.indexOf("x.test/gone")).toBeLessThan(out.indexOf("streams"));
    expect(out).toContain("✗");
    expect(out).toContain("✓");
    expect(activityWidget(theme, log, { collapsed: true, maxRows: 6 })).toHaveLength(1);
    log.clear();
    expect(activityWidget(theme, log, { collapsed: false, maxRows: 6 })).toEqual([]);
  });

  it("caps the activity log so it cannot grow without bound", () => {
    const log = new ActivityLog();
    for (let i = 0; i < 50; i++) log.add({ kind: "fetch", subject: `u${i}`, ms: 1, ok: true });
    expect(log.size).toBe(20);
  });
});

describe("mcp rendering", () => {
  it("titles a proxied call with its action and argument preview", () => {
    expect(view(renderMcpCall({ action: "call", tool: "chrome_shot", args: { format: "png" } }, theme, slot()))).toBe(
      'mcp call chrome_shot · {"format":"png"}',
    );
    expect(view(renderMcpCall({ action: "search", query: "shot" }, theme, slot()))).toBe('mcp search "shot"');
    expect(view(renderMcpCall({ action: "call", tool: "t", args: {} }, theme, slot()))).toBe("mcp call t");
  });

  it("renders a server status block with per-server glyphs", () => {
    const servers = [
      { name: "chrome", status: "connected", toolCount: 24, disabled: false, transport: "stdio", source: "a" },
      { name: "linear", status: "needs-auth", toolCount: 0, disabled: false, transport: "http", source: "b" },
    ] as never;
    const out = view(
      renderMcpResult({ content: [], details: { action: "status", servers } }, { expanded: false, isPartial: false }, theme, slot()),
    );
    expect(out).toContain("✓ 2 servers · 1 connected");
    expect(out).toContain("✓ chrome · connected · stdio · 24 tools");
    expect(out).toContain("○ linear · needs-auth");
  });

  it("summarizes matched tools and hides the tail", () => {
    const matches = Array.from({ length: 6 }, (_, i) => ({
      server: "s",
      name: `t${i}`,
      prefixedName: `s_t${i}`,
      description: `Tool ${i}`,
    }));
    const out = view(
      renderMcpResult({ content: [], details: { action: "search", matches, total: 6 } }, { expanded: false, isPartial: false }, theme, slot()),
    );
    expect(out).toContain("✓ 6 tools");
    expect(out).toContain("+2 more tools · ctrl+o to expand");
  });

  it("reports footer status only for enabled servers", () => {
    expect(
      mcpStatusText([
        { name: "a", status: "connected", toolCount: 1, disabled: false, transport: "stdio", source: "x" },
        { name: "b", status: "needs-auth", toolCount: 0, disabled: false, transport: "http", source: "x" },
        { name: "c", status: "disabled", toolCount: 0, disabled: true, transport: "http", source: "x" },
      ] as never),
    ).toBe("⚡ mcp 1/2 · 1 need auth");
    expect(mcpStatusText([{ name: "c", status: "disabled", toolCount: 0, disabled: true, transport: "http", source: "x" }] as never)).toBeUndefined();
    expect(mcpStatusText([])).toBeUndefined();
  });
});

describe("subagent rendering", () => {
  it("names the agents and the fan-out mode", () => {
    expect(
      view(renderSubagentCall({ tasks: [{ agent: "scout", task: "a" }, { agent: "reviewer", task: "b" }] }, theme, slot())),
    ).toBe("subagent scout, reviewer · parallel ×2");
    expect(view(renderSubagentCall({ agent: "scout", task: "Map the flow" }, theme, slot()))).toBe(
      "subagent scout\n  Map the flow",
    );
  });

  it("summarizes per-child outcome, cost, and skipped chain steps", () => {
    const out = view(
      renderSubagentResult(
        {
          content: [{ type: "text", text: "## scout\nfound it" }],
          details: {
            mode: "chain",
            skipped: 1,
            results: [
              { agent: "scout", exitCode: 0, durationMs: 18_400, usage: { input: 12_400, output: 890, cacheRead: 0, cacheWrite: 0, cost: 0.031, turns: 4 } },
              { agent: "worker", exitCode: 1, durationMs: 4200, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 }, error: "no API key" },
            ],
          },
        },
        { expanded: false, isPartial: false },
        theme,
        slot(),
      ),
    );
    expect(out).toContain("✓ 1/2 finished · 18.4s · 12.4k→890 tok · $0.031");
    expect(out).toContain("✓ scout · 18.4s · 4 turns");
    expect(out).toContain("✗ worker · 4.2s · 1 turn · no API key");
    expect(out).toContain("1 chain step(s) skipped");
  });

  it("shows a live spinner row per running child", () => {
    const now = 1_000_000;
    const runs = [
      { id: "a", agent: "scout", task: "Map the payment flow", startedAt: now - 18_400, activity: "", events: [] },
      { id: "b", agent: "reviewer", task: "Review tests", startedAt: now - 4200, activity: "read src/auth.ts", events: [{ kind: "tool", name: "read", args: "src/auth.ts", status: "running" }] },
    ] as never;
    const lines = fleetWidget(theme, runs, { collapsed: false, spawned: 5, budget: 16, now });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("2 running agents");
    expect(lines[0]).toContain("↓/← to inspect");

    const roster = fleetWidget(theme, runs, { collapsed: false, spawned: 5, budget: 16, now, roster: true, selectedId: "b" });
    expect(roster[0]).toContain("enter inspect");
    expect(roster.join("\n")).toContain("reviewer");

    expect(fleetWidget(theme, runs, { collapsed: true, spawned: 5, budget: 16, now })).toHaveLength(1);
    expect(fleetWidget(theme, [], { collapsed: false, spawned: 0, budget: 16, now })).toEqual([]);
  });

  it("maps a fleet click to that child and renders its live transcript", () => {
    const now = 1_000_000;
    const runs = [
      {
        id: "a",
        agent: "scout",
        task: "Map the payment flow",
        startedAt: now - 18_400,
        activity: "bash · git log",
        events: [
          { kind: "tool", name: "bash", args: "git log --oneline", status: "ok" },
          { kind: "text", text: "abc123 Wire the panel" },
        ],
      },
      { id: "b", agent: "reviewer", task: "Review tests", startedAt: now - 4200, activity: "", events: [] },
    ] as never;
    const layout = fleetLayout(theme, runs, { collapsed: false, spawned: 5, budget: 16, now, roster: true, selectedId: "a" });
    expect(layout.lines.join("\n")).toContain("scout");
    expect(hitTestFleet(layout.hits, layout.hits[0].y0)).toBe("a");
    expect(hitTestFleet(layout.hits, layout.hits[1].y0)).toBe("b");
    const inspect = conversationLines(theme, runs[0], now).join("\n");
    expect(inspect).toContain("Conversation");
    expect(inspect).toContain("git log --oneline");
    expect(inspect).toContain("abc123 Wire the panel");
    expect(renderTraceEvent(theme, { kind: "tool", name: "read", args: "src/auth.ts", status: "running" })).toContain("running");
  });

  it("marks the selected child in the roster column", () => {
    const now = 1_000_000;
    const runs = [
      { id: "a", agent: "scout", task: "Map the payment flow", startedAt: now - 18_400, activity: "", events: [] },
      { id: "b", agent: "reviewer", task: "Review tests", startedAt: now - 4200, activity: "", events: [] },
    ] as never;
    const rows = rosterLines(theme, runs, "b", now);
    expect(rows).toHaveLength(2);
    expect(rows[0]).not.toContain(">");
    expect(rows[1]).toContain(">");
    expect(rows[1]).toContain("reviewer");
    expect(rows[1]).toContain("b");
  });

  it("renders the inspector as a bordered two-column frame -- roster beside the live transcript", () => {
    const now = 1_000_000;
    const runs = [
      {
        id: "a",
        agent: "scout",
        task: "Map the payment flow",
        startedAt: now - 18_400,
        activity: "",
        events: [{ kind: "tool", name: "bash", args: "git log --oneline", status: "ok" }],
      },
      { id: "b", agent: "reviewer", task: "Review tests", startedAt: now - 4200, activity: "", events: [] },
    ] as never;
    const { lines, maxScroll } = inspectorFrame(theme, runs, "a", { width: 80, rows: 6, scroll: 0, now });
    expect(lines[0]).toContain("Subagent fleet inspector");
    expect(lines[0]).toContain("scout");
    expect(lines.at(-1)).toMatch(/^└─+┴─+┘$/);
    // Every framed row (border rows and content rows alike) must be exactly the requested width.
    for (const line of lines) expect(line.length).toBe(80);
    const body = lines.join("\n");
    expect(body).toContain("reviewer"); // roster column
    expect(body).toContain("git log --oneline"); // conversation column
    expect(maxScroll).toBe(0);
  });

  it("clamps inspector scroll to the conversation length and paginates long transcripts", () => {
    const now = 1_000_000;
    const events = Array.from({ length: 20 }, (_, i) => ({ kind: "text", text: `line ${i}` }));
    const runs = [{ id: "a", agent: "scout", task: "Long task", startedAt: now, activity: "", events }] as never;
    const { lines: page1, maxScroll } = inspectorFrame(theme, runs, "a", { width: 80, rows: 5, scroll: 0, now });
    expect(maxScroll).toBeGreaterThan(0);
    expect(page1.join("\n")).toContain("line 0");
    expect(page1.join("\n")).not.toContain("line 19");
    const { lines: pageOver } = inspectorFrame(theme, runs, "a", { width: 80, rows: 5, scroll: 999, now });
    expect(pageOver.join("\n")).toContain(`line ${20 - 5}`);
  });
});

describe("todo rendering", () => {
  it("strikes through completed work and lists unfinished first", () => {
    const out = view(
      renderTodoResult({ content: [{ type: "text", text: "Completed #2: Add pinning." }], details: { todos: TODOS, nextId: 5 } }, { expanded: false, isPartial: false }, theme, slot()),
    );
    expect(out).toContain("2/4");
    expect(out).toContain("Completed #2: Add pinning.");
    // Unfinished rows come before completed ones.
    expect(out.indexOf("#3 Wire the panel")).toBeLessThan(out.indexOf("Read the docs"));
    expect(out).toContain("~Read the docs~");
    expect(out).toContain("#4 Update the README · needs #3");
  });

  it("names the mutation in the call row", () => {
    expect(view(renderTodoCall({ action: "create", content: "Ship it" }, theme, slot()))).toBe('todo create "Ship it"');
    expect(view(renderTodoCall({ action: "update", id: 3, status: "in_progress" }, theme, slot()))).toBe(
      "todo update #3 · in_progress",
    );
  });

  it("says exactly what the widget hid", () => {
    const lines = todoWidget(theme, { todos: TODOS, nextId: 5 }, { collapsed: false, maxRows: 2 });
    expect(lines[0]).toContain("Todos");
    expect(lines[0]).toContain("2/4");
    expect(lines.at(-1)).toBe("  +2 more (2 completed)");
  });

  it("collapses to a single line naming the active task", () => {
    const lines = todoWidget(theme, { todos: TODOS, nextId: 5 }, { collapsed: true, maxRows: 8 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Wire the panel");
  });

  it("disappears when there is nothing to show", () => {
    expect(todoWidget(theme, { todos: [], nextId: 1 }, { collapsed: false, maxRows: 8 })).toEqual([]);
  });

  it("groups the /todos listing by status", () => {
    const out = formatTodosGrouped(TODOS);
    expect(out).toContain("Todos 2/4 completed");
    expect(out.indexOf("In progress (1)")).toBeLessThan(out.indexOf("Pending (1)"));
    expect(out.indexOf("Pending (1)")).toBeLessThan(out.indexOf("Completed (2)"));
    expect(formatTodosGrouped([])).toMatch(/No todos yet/);
  });
});

describe("question rendering", () => {
  it("shows each question with the answer that was chosen", () => {
    const out = view(
      renderAskResult(
        {
          content: [],
          details: {
            cancelled: false,
            answers: [
              { question: "Which cache?", header: "Cache", selected: ["Redis"] },
              { question: "Eviction?", selected: [], custom: "LRU" },
            ],
          },
        },
        { expanded: false, isPartial: false },
        theme,
        slot(),
      ),
    );
    expect(out).toContain("✓ 2 answered");
    expect(out).toContain("[Cache] Which cache?");
    expect(out).toContain("→ Redis");
    expect(out).toContain('→ "LRU"');
  });

  it("marks a fully cancelled questionnaire without a success glyph", () => {
    const out = view(
      renderAskResult({ content: [], details: { cancelled: true, answers: [] } }, { expanded: false, isPartial: false }, theme, slot()),
    );
    expect(out).toBe("○ cancelled");
  });

  it("titles the call with the first question", () => {
    expect(
      view(renderAskCall({ questions: [{ question: "Which cache?", options: [{ label: "A" }, { label: "B" }] }, { question: "B?", options: [] }] }, theme, slot())),
    ).toBe("ask_user_question Which cache? · 2 questions");
  });
});

describe("renderer robustness", () => {
  it("falls back to plain text instead of throwing on malformed details", () => {
    const hostile = { content: [{ type: "text", text: "raw text" }], details: { hits: "not-an-array" } } as never;
    expect(view(renderSearchResult(hostile, { expanded: false, isPartial: false }, theme, slot()))).toContain("raw text");
  });

  it("shows a working state while a result is still streaming", () => {
    expect(view(renderSearchResult({ content: [] }, { expanded: false, isPartial: true }, theme, slot()))).toContain("searching");
    expect(view(renderSubagentResult({ content: [{ type: "text", text: "scout: looking" }] }, { expanded: false, isPartial: true }, theme, slot()))).toContain(
      "scout: looking",
    );
  });
});
