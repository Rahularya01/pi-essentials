#!/usr/bin/env node
// Standalone, read-only viewer run inside a Herdr pane (see herdr.ts / index.ts).
// Tails a subagent's raw `pi --mode json` event log and prints a live transcript.
// Deliberately dependency-free plain JS: it runs as its own process, outside pi's
// extension loader, so it cannot import this package's TypeScript sources.

import fs from "node:fs";
import { pathToFileURL } from "node:url";

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function color(code, text) {
  return `${code}${text}${ANSI.reset}`;
}

function oneLine(text, max) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat;
}

/** Pure formatter: one parsed JSON event -> one printable line, or undefined to skip. */
export function formatEvent(event, state) {
  if (!event || typeof event !== "object") return undefined;

  if (event.type === "__meta__") {
    const lines = [
      color(ANSI.bold, `Subagent: ${event.agent ?? "agent"}`),
      color(ANSI.dim, `Task: ${oneLine(event.task ?? "", 100) || "(no task)"}`),
      color(ANSI.dim, "Read-only Herdr inspector · Ctrl+C to close this pane"),
      "",
    ];
    return lines.join("\n");
  }

  if (event.type === "tool_execution_start" && event.toolName) {
    return `${color(ANSI.yellow, "●")} ${color(ANSI.cyan, event.toolName)} ${color(ANSI.dim, "running")}`;
  }
  if (event.type === "tool_execution_end" && event.toolName) {
    const ok = !event.isError;
    return `${color(ok ? ANSI.green : ANSI.red, ok ? "✓" : "✗")} ${color(ANSI.cyan, event.toolName)}`;
  }
  if (event.type === "message_update") {
    const delta = event.assistantMessageEvent;
    if (delta?.type === "text_delta" && typeof delta.delta === "string") {
      state.textBuffer = (state.textBuffer ?? "") + delta.delta;
    }
    return undefined;
  }
  if (event.type === "message_end" && event.message?.role === "assistant") {
    if (event.message.errorMessage) {
      state.textBuffer = "";
      return color(ANSI.red, oneLine(event.message.errorMessage, 200));
    }
    const text = (state.textBuffer ?? "").trim();
    state.textBuffer = "";
    return text ? color(ANSI.dim, oneLine(text, 200)) : undefined;
  }
  return undefined;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--log") out.log = argv[++i];
  }
  return out;
}

function main() {
  const { log } = parseArgs(process.argv.slice(2));
  if (!log) {
    process.stderr.write("Usage: inspector-tail.mjs --log <path>\n");
    process.exitCode = 1;
    return;
  }

  const state = { textBuffer: "" };
  let offset = 0;
  let buffer = "";
  let missing = false;

  const consume = (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const raw of lines) {
      if (!raw.trim()) continue;
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        continue;
      }
      const line = formatEvent(event, state);
      if (line !== undefined) process.stdout.write(`${line}\n`);
    }
  };

  const poll = () => {
    let size;
    try {
      size = fs.statSync(log).size;
    } catch {
      if (!missing) {
        missing = true;
        process.stdout.write(`\n${color(ANSI.dim, "── run finished ──")}\n`);
      }
      return;
    }
    if (size <= offset) return;
    const fd = fs.openSync(log, "r");
    try {
      const length = size - offset;
      const chunk = Buffer.alloc(length);
      fs.readSync(fd, chunk, 0, length, offset);
      offset = size;
      consume(chunk.toString("utf8"));
    } finally {
      fs.closeSync(fd);
    }
  };

  poll();
  const timer = setInterval(poll, 200);
  process.on("SIGINT", () => {
    clearInterval(timer);
    process.exit(0);
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
