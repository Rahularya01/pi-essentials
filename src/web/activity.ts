import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatCount, formatDuration, GLYPH, headingRule, oneLine, safeKeyHint, shortUrl } from "../ui/render.ts";

export interface ActivityEntry {
  kind: "search" | "fetch";
  subject: string;
  detail?: string;
  ms: number;
  ok: boolean;
}

/** Entries kept for the activity panel. Old rows scroll off the bottom. */
const MAX_ENTRIES = 20;

/**
 * A short history of what the web tools actually did. Without it a fetch that
 * silently fell back to a different provider, or took eight seconds, leaves no
 * trace in the transcript.
 */
export class ActivityLog {
  private readonly entries: ActivityEntry[] = [];

  add(entry: ActivityEntry): void {
    this.entries.unshift(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES;
  }

  clear(): void {
    this.entries.length = 0;
  }

  get size(): number {
    return this.entries.length;
  }

  recent(limit: number): ActivityEntry[] {
    return this.entries.slice(0, Math.max(0, limit));
  }

  /** Start a timer that records the outcome either way. */
  track<T>(kind: ActivityEntry["kind"], subject: string, run: () => Promise<T>, describe: (value: T) => string): Promise<T> {
    const startedAt = Date.now();
    return run().then(
      (value) => {
        this.add({ kind, subject, detail: describe(value), ms: Date.now() - startedAt, ok: true });
        return value;
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.add({ kind, subject, detail: oneLine(message, 40), ms: Date.now() - startedAt, ok: false });
        throw error;
      },
    );
  }
}

export function searchDetail(result: { hits: unknown[] }): string {
  return `${result.hits.length} hits`;
}

export function fetchDetail(page: { totalChars: number }): string {
  return `${formatCount(page.totalChars)} chars`;
}

export interface ActivityWidgetOptions {
  collapsed: boolean;
  maxRows: number;
}

export function activityWidget(theme: Theme, log: ActivityLog, options: ActivityWidgetOptions): string[] {
  if (log.size === 0) return [];
  const heading = headingRule(theme, "Web activity") + theme.fg("dim", ` ${log.size} recent`);
  if (options.collapsed) {
    return [`${heading}  ${theme.fg("dim", `${GLYPH.sep} ${safeKeyHint("app.tools.expand", "expand")}`)}`];
  }

  const rows = log.recent(Math.max(1, options.maxRows)).map((entry) => {
    const verb = entry.kind === "search" ? "SEARCH" : "FETCH ";
    const subject = entry.kind === "fetch" ? shortUrl(entry.subject, 34) : `"${oneLine(entry.subject, 32)}"`;
    return (
      `  ${theme.fg("muted", verb)} ${theme.fg("text", subject.padEnd(36))}` +
      theme.fg("dim", `${(entry.detail ?? "").padEnd(20)}${formatDuration(entry.ms).padStart(7)} `) +
      theme.fg(entry.ok ? "success" : "error", entry.ok ? GLYPH.ok : GLYPH.fail)
    );
  });

  const hidden = log.size - rows.length;
  const lines = [heading, ...rows];
  if (hidden > 0) lines.push(theme.fg("dim", `  +${hidden} older`));
  return lines;
}
