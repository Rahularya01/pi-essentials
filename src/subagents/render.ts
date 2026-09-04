import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  failLine,
  firstText,
  formatCost,
  formatCount,
  formatDuration,
  GLYPH,
  headingRule,
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
import type { ActiveRun, RunUsage } from "./runner.ts";

interface ResultSummary {
  id?: string;
  agent?: string;
  exitCode?: number;
  durationMs?: number;
  usage?: RunUsage;
  model?: string;
  error?: string;
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
        // Progress updates carry "agent: partial answer".
        return `${theme.fg("accent", GLYPH.running)} ${theme.fg("muted", oneLine(text, 88) || "working…")}`;
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
        for (const line of text.split("\n")) out += `\n  ${theme.fg("toolOutput", oneLine(line, 100))}`;
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
}

/**
 * FleetView: a live row per running child, with a spinner and elapsed time so
 * the panel visibly advances even when a child is quiet.
 */
export function fleetWidget(theme: Theme, runs: ActiveRun[], options: FleetOptions): string[] {
  if (runs.length === 0) return [];
  const now = options.now ?? Date.now();
  const heading =
    headingRule(theme, "Subagents") +
    ` ${theme.fg("accent", String(runs.length))}${theme.fg("muted", " running")}` +
    theme.fg("dim", ` ${GLYPH.sep} ${options.spawned}/${options.budget} spawned`);

  if (options.collapsed) {
    const names = [...new Set(runs.map((run) => run.agent))].join(", ");
    return [`${heading}  ${theme.fg("dim", `${GLYPH.sep} ${oneLine(names, 40)}`)}`];
  }

  const lines = [heading];
  for (const run of runs) {
    lines.push(
      `  ${theme.fg("accent", spinnerFrame(run.startedAt, now))} ${theme.fg("text", run.agent)}` +
        theme.fg("dim", ` ${formatDuration(now - run.startedAt)} ${GLYPH.sep} ${oneLine(run.task, 44)}`),
    );
  }
  return lines;
}
