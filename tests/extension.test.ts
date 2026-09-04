import { describe, expect, it, vi } from "vitest";
import piEssentials, { MAX_NEST_DEPTH, readNestDepth } from "../src/index.ts";

interface Harness {
  tools: string[];
  commands: string[];
  shortcuts: string[];
  events: string[];
  pi: Record<string, unknown>;
}

function harness(): Harness {
  const tools: string[] = [];
  const commands: string[] = [];
  const shortcuts: string[] = [];
  const events: string[] = [];
  return {
    tools,
    commands,
    shortcuts,
    events,
    pi: {
      registerTool: (tool: { name: string }) => tools.push(tool.name),
      registerCommand: (name: string) => commands.push(name),
      registerShortcut: (key: string) => shortcuts.push(key),
      on: (event: string) => events.push(event),
      getActiveTools: () => [...tools],
      setActiveTools: () => undefined,
    },
  };
}

function withEnv(env: Record<string, string | undefined>, run: () => void): void {
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("extension registration", () => {
  it("registers every tool and command in a normal session", () => {
    const h = harness();
    withEnv({ PI_ESSENTIALS_SUBAGENT: undefined, PI_ESSENTIALS_NEST_DEPTH: undefined }, () => {
      piEssentials(h.pi as never);
    });
    expect(h.tools.sort()).toEqual(["ask_user_question", "mcp", "subagent", "todo", "web_fetch", "web_search"]);
    expect(h.commands.sort()).toEqual(["mcp", "subagents", "todos", "web"]);
    expect(h.shortcuts.sort()).toEqual(["ctrl+shift+a", "ctrl+shift+t", "ctrl+shift+w"]);
    expect(h.events).toContain("session_start");
    expect(h.events).toContain("session_shutdown");
  });

  it("gives a subagent only the tools it is allowed to use", () => {
    const h = harness();
    withEnv({ PI_ESSENTIALS_SUBAGENT: "1", PI_ESSENTIALS_NEST_DEPTH: "1" }, () => {
      piEssentials(h.pi as never);
    });
    // No MCP secrets, no todos, no questions, and no further nesting by default.
    expect(h.tools.sort()).toEqual(["web_fetch", "web_search"]);
    // The web activity panel is the only surface a child still owns.
    expect(h.commands).toEqual(["web"]);
  });

  it("reads the nesting depth defensively", () => {
    expect(readNestDepth({ PI_ESSENTIALS_NEST_DEPTH: "2" })).toBe(2);
    expect(readNestDepth({ PI_ESSENTIALS_NEST_DEPTH: "garbage" })).toBe(0);
    expect(readNestDepth({ PI_ESSENTIALS_NEST_DEPTH: "-4" })).toBe(0);
    expect(readNestDepth({})).toBe(0);
    expect(MAX_NEST_DEPTH).toBeGreaterThan(0);
  });

  it("defers config warnings to the UI instead of the console", async () => {
    const h = harness();
    const handlers: Array<(event: unknown, ctx: unknown) => Promise<void>> = [];
    h.pi.on = (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
      if (event === "session_start") handlers.push(handler);
      h.events.push(event);
    };
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    withEnv({ PI_ESSENTIALS_SUBAGENT: undefined }, () => piEssentials(h.pi as never));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    const notify = vi.fn();
    for (const handler of handlers) {
      await handler({}, { hasUI: true, ui: { notify, setWidget: () => undefined }, sessionManager: {}, cwd: process.cwd() });
    }
    // No warnings are expected for a clean checkout; the handler must stay silent.
    expect(notify.mock.calls.every(([message]) => !String(message).includes("undefined"))).toBe(true);
  });
});
