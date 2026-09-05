import { GLYPH, oneLine } from "../ui/render.ts";

const MAX_EVENTS = 48;
const SECRET_KEY = /(?:api[_-]?key|token|secret|password|passwd|authorization|cookie|credential)/i;
const ARG_KEYS = ["command", "path", "file", "file_path", "filePath", "query", "url", "pattern", "glob", "target", "name"];

export type TraceEvent =
  | { kind: "tool"; id?: string; name: string; args?: string; status: "running" | "ok" | "error" }
  | { kind: "text"; text: string };

export interface LiveTrace {
  activity: string;
  events: TraceEvent[];
  textBuffer: string;
}

export function emptyTrace(): LiveTrace {
  return { activity: "", events: [], textBuffer: "" };
}

function pushEvent(trace: LiveTrace, event: TraceEvent): void {
  const last = trace.events.at(-1);
  if (event.kind === "text" && last?.kind === "text" && last.text === event.text) return;
  trace.events.push(event);
  if (trace.events.length > MAX_EVENTS) trace.events.splice(0, trace.events.length - MAX_EVENTS);
}

function stringArg(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return oneLine(value, 48);
  return undefined;
}

export function summarizeToolArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const rec = args as Record<string, unknown>;
  for (const key of ARG_KEYS) {
    if (SECRET_KEY.test(key)) continue;
    const value = stringArg(rec[key]);
    if (value) return value;
  }
  for (const [key, raw] of Object.entries(rec)) {
    if (SECRET_KEY.test(key)) continue;
    const value = stringArg(raw);
    if (value) return value;
  }
  return undefined;
}

export function summarizeTool(name: string, args: unknown): string {
  const detail = summarizeToolArgs(args);
  const label = name.trim() || "tool";
  return detail ? `${label} ${GLYPH.sep} ${detail}` : label;
}

function recordActivity(trace: LiveTrace, activity: string): boolean {
  const next = oneLine(activity, 64);
  if (!next || next === trace.activity) return false;
  trace.activity = next;
  return true;
}

function findTool(trace: LiveTrace, id: string | undefined, name: string): Extract<TraceEvent, { kind: "tool" }> | undefined {
  if (id) {
    for (let i = trace.events.length - 1; i >= 0; i--) {
      const event = trace.events[i];
      if (event.kind === "tool" && event.id === id) return event;
    }
  }
  for (let i = trace.events.length - 1; i >= 0; i--) {
    const event = trace.events[i];
    if (event.kind === "tool" && event.name === name && event.status === "running") return event;
  }
  return undefined;
}

/**
 * Fold a child `pi --mode json` event into a live trace.
 * Returns true when the fleet/inspector should redraw.
 */
export function applySessionEvent(trace: LiveTrace, event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const rec = event as {
    type?: string;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    args?: unknown;
    assistantMessageEvent?: { type?: string; delta?: string };
    message?: { role?: string; content?: unknown; errorMessage?: string };
  };

  if (rec.toolName === "subagent_result") return false;

  if (rec.type === "tool_execution_start" && rec.toolName) {
    const args = summarizeToolArgs(rec.args);
    pushEvent(trace, { kind: "tool", id: rec.toolCallId, name: rec.toolName, args, status: "running" });
    return recordActivity(trace, summarizeTool(rec.toolName, rec.args)) || true;
  }

  if (rec.type === "tool_execution_end" && rec.toolName) {
    const tool = findTool(trace, rec.toolCallId, rec.toolName);
    const status = rec.isError ? "error" : "ok";
    if (tool) tool.status = status;
    else pushEvent(trace, { kind: "tool", id: rec.toolCallId, name: rec.toolName, status });
    return recordActivity(trace, rec.isError ? `${rec.toolName} failed` : summarizeTool(rec.toolName, rec.args)) || true;
  }

  if (rec.type === "message_update") {
    const delta = rec.assistantMessageEvent;
    if (delta?.type === "text_delta" && typeof delta.delta === "string" && delta.delta) {
      trace.textBuffer += delta.delta;
      return recordActivity(trace, trace.textBuffer);
    }
    return false;
  }

  if (rec.type === "message_end" && rec.message?.role === "assistant") {
    if (rec.message.errorMessage) {
      pushEvent(trace, { kind: "text", text: oneLine(rec.message.errorMessage, 120) });
      return recordActivity(trace, rec.message.errorMessage) || true;
    }
    const text = trace.textBuffer.trim();
    trace.textBuffer = "";
    if (text) {
      pushEvent(trace, { kind: "text", text: oneLine(text, 160) });
      return recordActivity(trace, text) || true;
    }
    return false;
  }

  return false;
}
