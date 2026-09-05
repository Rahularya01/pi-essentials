import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import {
  failLine,
  firstText,
  formatCost,
  formatCount,
  formatDuration,
  GLYPH,
  meta,
  okLine,
  oneLine,
  plural,
  safeKeyHint,
  safeRender,
  spinnerFrame,
  titleLine,
  type RenderableResult,
  type RenderSlot,
} from "../ui/render.ts";
import type { TraceEvent } from "./activity.ts";
import type { ActiveRun, RunUsage } from "./runner.ts";

type DisplayRun = ActiveRun & {
  status?: "running" | "cancelling" | "succeeded" | "failed";
  finishedAt?: number;
  output?: string;
  error?: string;
  usage?: RunUsage;
  model?: string;
};

interface ResultSummary {
  id?: string;
  agent?: string;
  exitCode?: number;
  durationMs?: number;
  usage?: RunUsage;
  model?: string;
  error?: string;
  activity?: string;
  events?: TraceEvent[];
  running?: boolean;
  status?: "queued" | "running" | "cancelling" | "succeeded" | "failed";
  task?: string;
}

interface SubagentDetails {
  mode?: string;
  skipped?: number;
  results?: ResultSummary[];
}

interface SubagentArgs {
  agent?: string;
  task?: string;
  tasks?: Array<{ agent: string; task: string }>;
  chain?: Array<{ agent: string; task: string }>;
}

export function renderSubagentCall(args: SubagentArgs, theme: Theme, context: RenderSlot): Text {
  return safeRender(
    () => {
      const jobs = args?.tasks ?? args?.chain ?? (args?.agent ? [{ agent: args.agent, task: args.task ?? "" }] : []);
      const mode = args?.chain?.length ? "chain" : args?.tasks?.length ? "parallel" : "single";
      const agents = [...new Set(jobs.map((job) => job.agent))].join(", ");
      let line = titleLine(theme, "subagent", agents || undefined);
      line += meta(theme, [mode !== "single" ? `${mode} ×${jobs.length}` : undefined]);
      if (jobs.length === 1 && jobs[0]?.task) {
        line += `\n  ${theme.fg("dim", oneLine(jobs[0].task, 88))}`;
      }
      return line;
    },
    "subagent",
    context,
  );
}

export function renderSubagentResult(
  result: RenderableResult<SubagentDetails | undefined>,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: RenderSlot,
): Text {
  return safeRender(
    () => {
      const text = firstText(result);
      if (options.isPartial) {
        const live = result?.details?.results ?? [];
        if (live.length === 0) {
          return `${theme.fg("accent", GLYPH.running)} ${theme.fg("muted", oneLine(text, 88) || "working…")}`;
        }
        const states = live.map((row) => row.status === "queued" ? "queued"
          : row.status === "failed" || (row.exitCode !== undefined && row.exitCode !== 0) ? "failed"
          : row.status === "succeeded" || row.running === false || row.exitCode === 0 ? "completed"
          : row.status ?? "running");
        const header = theme.fg("text", "Subagents") + meta(theme,
          ["running", "cancelling", "queued", "completed", "failed"].map((state) => {
            const count = states.filter((value) => value === state).length;
            return count ? `${count} ${state}` : undefined;
          }));
        const rows = live.map((row, index) => {
          const state = states[index];
          const glyph = state === "completed" ? GLYPH.ok : state === "failed" ? GLYPH.fail : state === "queued" ? "○" : "●";
          const line = `${theme.fg(state === "failed" ? "error" : state === "completed" ? "success" : "accent", glyph)} ${theme.fg("accent", row.agent ?? "agent")}` +
            meta(theme, [row.id, state, row.durationMs !== undefined ? formatDuration(row.durationMs) : undefined,
              row.usage ? `${formatCount(row.usage.input)}→${formatCount(row.usage.output)} tok` : undefined,
              formatCost(row.usage?.cost ?? 0), row.model]) +
            theme.fg("dim", ` ${GLYPH.sep} ${oneLine(row.error || row.activity || row.task || state || "working…", 56)}`);
          if (!options.expanded) return line;
          const events = row.events ?? [];
          if (events.length === 0) return line;
          return `${line}\n${events.map((event) => `    ${renderTraceEvent(theme, event)}`).join("\n")}`;
        });
        let out = header;
        for (const row of rows) out += `\n  ${row}`;
        if (!options.expanded) {
          out += theme.fg("dim", `\n  ${safeKeyHint("app.tools.expand", "for live detail")} ${GLYPH.sep} ↓/← fleet`);
        }
        return out;
      }
      if (context.isError) return failLine(theme, oneLine(text || "subagent failed", 96));

      const results = result?.details?.results ?? [];
      const totals = results.reduce(
        (sum, row) => ({
          input: sum.input + (row.usage?.input ?? 0),
          output: sum.output + (row.usage?.output ?? 0),
          cost: sum.cost + (row.usage?.cost ?? 0),
          ms: Math.max(sum.ms, row.durationMs ?? 0),
        }),
        { input: 0, output: 0, cost: 0, ms: 0 },
      );

      const failed = results.filter((row) => row.exitCode !== 0).length;
      const header =
        okLine(theme, theme.fg("text", `${results.length - failed}/${results.length} finished`)) +
        meta(theme, [
          totals.ms ? formatDuration(totals.ms) : undefined,
          totals.input || totals.output
            ? `${formatCount(totals.input)}→${formatCount(totals.output)} tok`
            : undefined,
          formatCost(totals.cost),
        ]);

      const rows = results.map((row) => {
        const ok = row.exitCode === 0;
        return (
          `${theme.fg(ok ? "success" : "error", ok ? GLYPH.ok : GLYPH.fail)} ${theme.fg("accent", row.agent ?? "agent")}` +
          meta(theme, [row.id]) +
          theme.fg(
            "dim",
            ` ${GLYPH.sep} ${formatDuration(row.durationMs ?? 0)}` +
              (row.usage?.turns ? ` ${GLYPH.sep} ${plural(row.usage.turns, "turn")}` : "") +
              (row.error ? ` ${GLYPH.sep} ${oneLine(row.error, 40)}` : ""),
          )
        );
      });

      let out = header;
      for (const row of rows) out += `\n  ${row}`;
      if (result?.details?.skipped) {
        out += theme.fg("warning", `\n  ${GLYPH.sep} ${result.details.skipped} chain step(s) skipped after a failure`);
      }
      if (options.expanded) {
        for (const line of text.split("\n")) out += `\n  ${theme.fg("toolOutput", line)}`;
      } else {
        out += theme.fg("dim", `\n  ${safeKeyHint("app.tools.expand", "to read the answers")}`);
      }
      return out;
    },
    oneLine(firstText(result), 120),
    context,
  );
}

export interface FleetOptions {
  collapsed: boolean;
  spawned: number;
  budget: number;
  now?: number;
  selectedId?: string;
  roster?: boolean;
}

export interface FleetHit {
  y0: number;
  y1: number;
  id: string;
}

export interface FleetLayout {
  lines: string[];
  hits: FleetHit[];
}

function runPreview(run: ActiveRun): string {
  return truncateToWidth((run.activity || run.task).replace(/\s+/g, " ").trim(), 44);
}

/** Six compact rows; roster mode changes focus and hints, not visibility. */
export function fleetLayout(theme: Theme, runs: DisplayRun[], options: FleetOptions, width = 120): FleetLayout {
  if (runs.length === 0) return { lines: [], hits: [] };
  const now = options.now ?? Date.now();
  const running = runs.filter((run) => !run.status || run.status === "running" || run.status === "cancelling").length;
  const noun = running === 1 ? "agent" : "agents";
  const compact =
    `  ${theme.fg("muted", `${running} running ${noun}`)}` +
    theme.fg("dim", ` ${GLYPH.sep} ${options.spawned}/${options.budget} spawned ${GLYPH.sep} ${options.roster ? "↑↓/jk select · enter inspect · h herdr · esc back" : "↓/← to inspect"}`);

  if (options.collapsed || !options.roster) {
    return { lines: [truncateToWidth(compact, Math.max(0, width))], hits: [] };
  }

  const lines = [compact];
  const hits: FleetHit[] = [];
  const selectedIndex = Math.max(0, runs.findIndex((run) => run.id === options.selectedId));
  const start = Math.max(0, Math.min(selectedIndex - 3, runs.length - 6));
  for (const run of runs.slice(start, start + 6)) {
    const selected = options.roster && run.id === options.selectedId;
    const y0 = lines.length;
    const marker = selected ? ">" : " ";
    const name = selected ? theme.bold(theme.fg("accent", run.agent)) : theme.fg("text", run.agent);
    lines.push(
      `${marker} ${theme.fg("accent", run.status === "succeeded" ? GLYPH.ok : run.status === "failed" ? GLYPH.fail : spinnerFrame(run.startedAt, now))} ${theme.fg("dim", `[${run.id}]`)} ${name}` +
        theme.fg("dim", ` ${formatDuration((run.finishedAt ?? now) - run.startedAt)} ${GLYPH.sep} ${run.status === "cancelling" ? "cancelling · " : ""}${runPreview(run)}`),
    );
    hits.push({ y0, y1: lines.length, id: run.id });
  }
  if (runs.length > 6) lines.push(theme.fg("dim", `  ${start + 1}-${Math.min(start + 6, runs.length)} of ${runs.length} agents`));
  return { lines: lines.map((line) => truncateToWidth(line, Math.max(0, width))), hits };
}

export function fleetWidget(theme: Theme, runs: ActiveRun[], options: FleetOptions): string[] {
  return fleetLayout(theme, runs, options).lines;
}

export function hitTestFleet(hits: FleetHit[], y: number): string | undefined {
  return hits.find((hit) => y >= hit.y0 && y < hit.y1)?.id;
}

/** Clickable below-editor roster. Stable across ticker frames so mouse clicks land. */
export class FleetPanel implements Component {
  private theme: Theme | undefined;
  private runs: ActiveRun[] = [];
  private options: FleetOptions = { collapsed: false, spawned: 0, budget: 0 };
  private hits: FleetHit[] = [];
  onSelect: ((id: string) => void) | undefined;

  setTheme(theme: Theme): void {
    this.theme = theme;
  }

  setState(runs: ActiveRun[], options: FleetOptions): void {
    this.runs = runs;
    this.options = options;
  }

  render(width: number): string[] {
    if (!this.theme) return [];
    const layout = fleetLayout(this.theme, this.runs, this.options, width);
    this.hits = layout.hits;
    return layout.lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click" || event.button !== "left") return undefined;
    const id = hitTestFleet(this.hits, event.y);
    if (!id) return undefined;
    this.onSelect?.(id);
    return { handled: true, render: true };
  }

  invalidate(): void {}
}

function toolGlyph(theme: Theme, status: Extract<TraceEvent, { kind: "tool" }>["status"]): string {
  if (status === "running") return theme.fg("warning", "●");
  if (status === "error") return theme.fg("error", GLYPH.fail);
  return theme.fg("success", GLYPH.ok);
}

export function renderTraceEvent(theme: Theme, event: TraceEvent): string {
  if (event.kind === "tool") {
    const args = event.args ? ` ${theme.fg("dim", event.args)}` : "";
    const suffix = event.status === "running" ? theme.fg("warning", " running") : "";
    return `${theme.fg("borderMuted", "├─")} ${toolGlyph(theme, event.status)} ${theme.fg("toolTitle", event.name)}${args}${suffix}`;
  }
  return `${theme.fg("accent", "◆")} ${theme.fg("toolOutput", event.text)}`;
}

/** The selected child's header, task, and live tool/text transcript -- the right column of the inspector frame. */
export function conversationLines(theme: Theme, run: ActiveRun | undefined, now = Date.now()): string[] {
  if (!run) return [theme.fg("muted", "Subagent finished.")];
  const heading = `${theme.fg("accent", "●")} ${theme.bold(run.agent)}` +
    theme.fg("dim", `  running ${GLYPH.sep} ${formatDuration(now - run.startedAt)}` +
      (run.activity ? ` ${GLYPH.sep} ${oneLine(run.activity, 40)}` : ""));
  const lines = [
    heading,
    `  ${theme.fg("muted", `Task: ${oneLine(run.task, 72) || "(no task)"}`)}`,
    `${theme.fg("accent", "Conversation")} ${theme.fg("dim", "· live")}`,
  ];
  const events = run.events ?? [];
  if (events.length === 0) lines.push(`  ${theme.fg("muted", "waiting for the child to start…")}`);
  else for (const event of events) lines.push(renderTraceEvent(theme, event));
  return lines;
}

/** One row per child for the inspector's left roster column. */
export function rosterLines(theme: Theme, runs: ActiveRun[], selectedId: string | undefined, now = Date.now()): string[] {
  return runs.map((run) => {
    const selected = run.id === selectedId;
    const marker = selected ? theme.fg("accent", ">") : " ";
    const name = selected ? theme.bold(theme.fg("accent", run.agent)) : theme.fg("text", run.agent);
    return `${marker} ${theme.fg("accent", spinnerFrame(run.startedAt, now))} ${name}` +
      theme.fg("dim", `  ${run.id} ${GLYPH.sep} ${formatDuration(now - run.startedAt)}`);
  });
}

const BOX = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", td: "┬", bu: "┴" } as const;

/** Pad/truncate to an exact visible width, ANSI-safe (colored text keeps its escapes). */
function cell(text: string, width: number): string {
  return truncateToWidth(text, Math.max(0, width), "…", true);
}

function frameTitleBar(theme: Theme, title: string, status: string, width: number): string {
  const inner = Math.max(0, width - 2);
  const left = ` ${title} `;
  const right = status ? ` ${status} ` : "";
  const dashWidth = Math.max(1, inner - left.length - visibleWidth(right));
  return (
    theme.fg("borderMuted", BOX.tl) +
    theme.bold(theme.fg("text", left)) +
    theme.fg("borderMuted", BOX.h.repeat(dashWidth)) +
    right +
    theme.fg("borderMuted", BOX.tr)
  );
}

function frameRule(theme: Theme, leftWidth: number, rightWidth: number, corners: readonly [string, string, string]): string {
  return theme.fg(
    "borderMuted",
    `${corners[0]}${BOX.h.repeat(leftWidth)}${corners[1]}${BOX.h.repeat(rightWidth)}${corners[2]}`,
  );
}

function frameContentRow(theme: Theme, left: string, right: string, leftWidth: number, rightWidth: number): string {
  return `${theme.fg("borderMuted", BOX.v)}${cell(left, leftWidth)}${theme.fg("borderMuted", BOX.v)}${cell(right, rightWidth)}${theme.fg("borderMuted", BOX.v)}`;
}

/**
 * Two-column bordered inspector frame -- a roster column beside the selected
 * child's live transcript, matching pi-subagents' Fleet inspector layout
 * instead of a single stacked list.
 */
export function inspectorFrame(
  theme: Theme,
  runs: ActiveRun[],
  selectedId: string | undefined,
  options: { width: number; rows: number; scroll: number; now?: number },
): { lines: string[]; maxScroll: number } {
  const now = options.now ?? Date.now();
  const run = (selectedId ? runs.find((r) => r.id === selectedId) : undefined) ?? runs[0];
  const width = Math.max(20, options.width);
  const leftWidth = Math.min(40, Math.max(18, Math.floor((width - 3) * 0.3)));
  const rightWidth = Math.max(10, width - 3 - leftWidth);

  const status = run ? `${theme.fg("accent", "●")} ${theme.bold(run.agent)} ${theme.fg("dim", GLYPH.sep)} ${theme.fg("muted", "running")}` : "";
  const title = "Subagent fleet inspector · live controls";

  const roster = rosterLines(theme, runs, run?.id, now);
  const conversation = conversationLines(theme, run, now);
  const rows = Math.max(3, options.rows);
  const maxScroll = Math.max(0, conversation.length - rows);
  const scroll = Math.max(0, Math.min(options.scroll, maxScroll));
  const visibleConversation = conversation.slice(scroll, scroll + rows);

  const lines: string[] = [frameTitleBar(theme, title, status, width)];
  for (let i = 0; i < rows; i++) {
    lines.push(frameContentRow(theme, roster[i] ?? "", visibleConversation[i] ?? "", leftWidth, rightWidth));
  }
  lines.push(frameRule(theme, leftWidth, rightWidth, [BOX.bl, BOX.bu, BOX.br]));
  return { lines, maxScroll };
}

/** Overlay inspector: roster of children plus the selected child's live transcript. */
export class InspectorPanel implements Component {
  private scroll = 0;

  constructor(
    private readonly getRuns: () => ActiveRun[],
    private readonly getSelectedId: () => string | undefined,
    private readonly onSelect: (id: string) => void,
    private readonly theme: Theme,
    private readonly done: () => void,
    private readonly tui: { requestRender(): void },
    private readonly onOpenHerdr?: (run: ActiveRun) => void,
  ) {}

  private selectedRun(): ActiveRun | undefined {
    const runs = this.getRuns();
    const id = this.getSelectedId();
    return (id ? runs.find((run) => run.id === id) : undefined) ?? runs[0];
  }

  private move(delta: number): void {
    const runs = this.getRuns();
    if (runs.length === 0) {
      this.done();
      return;
    }
    const current = this.selectedRun();
    const index = Math.max(0, runs.findIndex((run) => run.id === current?.id));
    const next = runs[Math.max(0, Math.min(runs.length - 1, index + delta))];
    if (next) this.onSelect(next.id);
    this.scroll = 0;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const runs = this.getRuns();
    const run = this.selectedRun();
    if (!run) {
      this.done();
      return [this.theme.fg("muted", "No running subagents.")];
    }
    const rows = 16;
    const { lines, maxScroll } = inspectorFrame(this.theme, runs, run.id, { width, rows, scroll: this.scroll });
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    const footer = this.theme.fg("dim", `  ↑↓/jk agent ${GLYPH.sep} h herdr pane ${GLYPH.sep} pgup/pgdn scroll ${GLYPH.sep} esc close`);
    return [...lines, footer];
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.done();
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) this.move(1);
    else if (matchesKey(data, "up") || matchesKey(data, "k")) this.move(-1);
    else if (matchesKey(data, "h")) {
      const run = this.selectedRun();
      if (run) this.onOpenHerdr?.(run);
    } else if (matchesKey(data, "pageDown")) {
      this.scroll += 8;
      this.tui.requestRender();
    } else if (matchesKey(data, "pageUp")) {
      this.scroll -= 8;
      this.tui.requestRender();
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel" && event.wheelDelta) {
      this.scroll += event.wheelDelta < 0 ? -1 : 1;
      this.tui.requestRender();
      return { handled: true, render: true };
    }
    return undefined;
  }

  invalidate(): void {}
}
