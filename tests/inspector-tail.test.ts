import { describe, expect, it } from "vitest";
import { formatEvent } from "../src/subagents/inspector-tail.mjs";

describe("inspector-tail formatEvent", () => {
  it("prints a header for the meta line", () => {
    const line = formatEvent({ type: "__meta__", agent: "scout", task: "Map the payment flow" }, {});
    expect(line).toContain("scout");
    expect(line).toContain("Map the payment flow");
  });

  it("shows a running marker when a tool starts and a result marker when it ends", () => {
    const start = formatEvent({ type: "tool_execution_start", toolName: "read" }, {});
    expect(start).toContain("read");
    expect(start).toContain("running");

    const ok = formatEvent({ type: "tool_execution_end", toolName: "read", isError: false }, {});
    expect(ok).toContain("read");

    const failed = formatEvent({ type: "tool_execution_end", toolName: "bash", isError: true }, {});
    expect(failed).toContain("bash");
  });

  it("buffers assistant text deltas and prints them on message_end", () => {
    const state = {};
    expect(formatEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello " } }, state)).toBeUndefined();
    expect(formatEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } }, state)).toBeUndefined();
    const line = formatEvent({ type: "message_end", message: { role: "assistant" } }, state);
    expect(line).toContain("Hello world");
  });

  it("surfaces an assistant error message instead of buffered text", () => {
    const state = { textBuffer: "partial thought" };
    const line = formatEvent({ type: "message_end", message: { role: "assistant", errorMessage: "rate limited" } }, state);
    expect(line).toContain("rate limited");
    expect(state.textBuffer).toBe("");
  });

  it("ignores events it does not understand", () => {
    expect(formatEvent({ type: "something_else" }, {})).toBeUndefined();
    expect(formatEvent(null, {})).toBeUndefined();
    expect(formatEvent(undefined, {})).toBeUndefined();
  });
});
