import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/**
 * Shared vocabulary for every pi-essentials surface.
 *
 * The house style is one compact line per tool row: a bold tool name, the
 * subject it acted on, then dimmed metadata. Detail is available on demand
 * through the expand key rather than printed by default.
 */

export const GLYPH = {
  ok: "✓",
  fail: "✗",
  pending: "○",
  running: "▶",
  done: "✓",
  bullet: "•",
  arrow: "→",
  sep: "·",
} as const;

/** Braille spinner frames, matched to the rhythm of pi's own working indicator. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinnerFrame(startedAt: number, now = Date.now()): string {
  return SPINNER[Math.floor((now - startedAt) / 80) % SPINNER.length];
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) < 1000) return String(Math.round(value));
  if (Math.abs(value) < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Collapse whitespace and hard-truncate for single-line previews. */
export function oneLine(text: string, max = 72): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(1, max - 1))}…`;
}

/** Shorten a URL to the part a reader actually scans. */
export function shortUrl(raw: string, max = 56): string {
  try {
    const url = new URL(raw);
    const tail = `${url.pathname}${url.search}`.replace(/\/$/, "");
    return oneLine(`${url.host}${tail}`, max);
  } catch {
    return oneLine(raw, max);
  }
}

export function titleLine(theme: Theme, tool: string, subject?: string): string {
  let line = theme.fg("toolTitle", theme.bold(tool));
  if (subject) line += ` ${theme.fg("text", oneLine(subject, 64))}`;
  return line;
}

/** Dimmed `a · b · c` metadata tail. */
export function meta(theme: Theme, parts: Array<string | undefined | false>): string {
  const kept = parts.filter((part): part is string => Boolean(part && part.length > 0));
  if (kept.length === 0) return "";
  return theme.fg("dim", ` ${GLYPH.sep} ${kept.join(` ${GLYPH.sep} `)}`);
}

export function okLine(theme: Theme, text: string): string {
  return `${theme.fg("success", GLYPH.ok)} ${text}`;
}

export function failLine(theme: Theme, text: string): string {
  return `${theme.fg("error", GLYPH.fail)} ${theme.fg("error", text)}`;
}

/** "Ctrl+O to expand" using whatever the user actually bound. */
export function expandHint(theme: Theme, hidden: number, noun = "line"): string {
  if (hidden <= 0) return "";
  const label = hidden === 1 ? noun : `${noun}s`;
  return theme.fg("dim", `\n  +${hidden} more ${label} ${GLYPH.sep} ${safeKeyHint("app.tools.expand", "to expand")}`);
}

/**
 * Default keys for the hints we print. Pi exposes `keyHint()` to resolve a
 * user's actual binding, but only from the package root, whose module graph
 * pulls an undeclared optional dependency and throws on import. Static defaults
 * keep the renderers dependency-free; `keyHints` below lets a caller override.
 */
const DEFAULT_KEYS: Record<string, string> = {
  "app.tools.expand": "ctrl+o",
};

const keyOverrides = new Map<string, string>();

/** Point a hint id at the user's real binding, when something knows it. */
export function setKeyHint(id: string, key: string): void {
  keyOverrides.set(id, key);
}

export function safeKeyHint(id: string, description: string): string {
  const key = keyOverrides.get(id) ?? DEFAULT_KEYS[id];
  return key ? `${key} ${description}` : description;
}

export interface IndentedOptions {
  /** Maximum entries to show before summarizing the remainder. */
  limit: number;
  indent?: string;
  /** What the hidden entries are called, e.g. "result", "tool". */
  noun?: string;
}

/** Render body lines under a header, capped unless expanded. */
export function body(theme: Theme, lines: string[], expanded: boolean, options: IndentedOptions): string {
  const indent = options.indent ?? "  ";
  const kept = expanded ? lines : lines.slice(0, options.limit);
  let out = kept.map((line) => `\n${indent}${line}`).join("");
  const hidden = lines.length - kept.length;
  if (hidden > 0) out += expandHint(theme, hidden, options.noun);
  return out;
}

/** "1 turn" / "2 turns" without a separate plural table. */
export function plural(count: number, noun: string, suffix = "s"): string {
  return `${count} ${noun}${count === 1 ? "" : suffix}`;
}

/**
 * Money at a readable precision. Subagent runs routinely cost fractions of a
 * cent, so two decimals would round most of them to `$0.00`.
 */
export function formatCost(cost: number): string | undefined {
  if (!Number.isFinite(cost) || cost <= 0) return undefined;
  if (cost < 0.01) return `$${Number(cost.toPrecision(2))}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

/**
 * Structural view of a tool result for renderers. Kept loose so it accepts
 * `AgentToolResult<D>` without importing the agent-core types directly.
 */
export interface RenderableResult<D> {
  content: readonly unknown[];
  details?: D;
}

/** Context slice the renderers actually use. */
export interface RenderSlot {
  lastComponent?: unknown;
  isError?: boolean;
}

/** First text block of a tool result, ignoring images and other content types. */
export function firstText(result: { content?: readonly unknown[] } | undefined): string {
  for (const part of result?.content ?? []) {
    if (part && typeof part === "object") {
      const record = part as { type?: unknown; text?: unknown };
      if (record.type === "text" && typeof record.text === "string") return record.text;
    }
  }
  return "";
}

/** Reuse the previous Text instance so the TUI can diff in place. */
export function textRow(context: { lastComponent?: unknown }, content: string): Text {
  const existing = context.lastComponent;
  if (existing instanceof Text) {
    existing.setText(content);
    return existing;
  }
  return new Text(content, 0, 0);
}

/**
 * Wrap a renderer so a formatting mistake degrades to plain text instead of
 * breaking the transcript.
 */
export function safeRender(build: () => string, fallback: string, context: { lastComponent?: unknown }): Text {
  try {
    return textRow(context, build());
  } catch {
    return textRow(context, fallback);
  }
}

/** Horizontal rule used as a widget heading, e.g. `── Todos ── 2/7 ──────`. */
export function headingRule(theme: Theme, label: string, width = 46): string {
  const text = ` ${label} `;
  const fill = Math.max(0, width - text.length - 2);
  return theme.fg("borderMuted", "──") + theme.fg("muted", text) + theme.fg("borderMuted", "─".repeat(fill));
}

/** Compact progress meter: `▪▪▪▪▫▫▫`. */
export function progressBar(theme: Theme, done: number, total: number, width = 10): string {
  if (total <= 0) return "";
  const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)));
  return theme.fg("success", "▪".repeat(filled)) + theme.fg("dim", "▫".repeat(width - filled));
}
