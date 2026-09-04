import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  failLine,
  firstText,
  GLYPH,
  headingRule,
  meta,
  oneLine,
  progressBar,
  safeKeyHint,
  safeRender,
  titleLine,
  type RenderableResult,
  type RenderSlot,
} from "../ui/render.ts";
import type { TodoItem, TodoState } from "./state.ts";

interface TodoDetails {
  todos?: TodoItem[];
  nextId?: number;
  action?: string;
}

const STATUS_GLYPH: Record<TodoItem["status"], string> = {
  completed: GLYPH.done,
  in_progress: GLYPH.running,
  pending: GLYPH.pending,
  blocked: "!",
  abandoned: "–",
};

const STATUS_COLOR = {
  completed: "success",
  in_progress: "accent",
  pending: "muted",
  blocked: "warning",
  abandoned: "dim",
} as const;

/** One task line: glyph, id, text. Completed work is struck through. */
export function todoLine(theme: Theme, todo: TodoItem, width = 60): string {
  const color = STATUS_COLOR[todo.status];
  const label = oneLine(todo.content, width);
  const text = todo.status === "completed" || todo.status === "abandoned"
    ? theme.strikethrough(theme.fg("dim", label))
    : theme.fg("text", label);
  const dependencies = todo.blockedBy?.length ? `needs ${todo.blockedBy.map((id) => `#${id}`).join(",")}` : undefined;
  const details = [todo.phase && `phase ${todo.phase}`, todo.blocker && `blocked: ${todo.blocker}`, dependencies]
    .filter((part): part is string => Boolean(part));
  const metadata = details.length > 0 ? theme.fg("dim", ` ${GLYPH.sep} ${details.join(` ${GLYPH.sep} `)}`) : "";
  return `${theme.fg(color, STATUS_GLYPH[todo.status])} ${theme.fg("dim", `#${todo.id}`)} ${text}${metadata}`;
}

export function renderTodoCall(
  args: { action?: string; content?: string; id?: number; status?: string },
  theme: Theme,
  context: RenderSlot,
): Text {
  return safeRender(
    () => {
      const subject = args?.content ? `"${oneLine(args.content, 48)}"` : args?.id !== undefined ? `#${args.id}` : undefined;
      return (
        titleLine(theme, "todo") +
        ` ${theme.fg("accent", args?.action ?? "")}` +
        (subject ? ` ${theme.fg("text", subject)}` : "") +
        meta(theme, [args?.status])
      );
    },
    "todo",
    context,
  );
}

export function renderTodoResult(
  result: RenderableResult<TodoDetails | undefined>,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: RenderSlot,
): Text {
  return safeRender(
    () => {
      if (context.isError) return failLine(theme, oneLine(firstText(result) || "todo update failed", 96));

      const todos = result?.details?.todos ?? [];
      if (todos.length === 0) {
        return `${theme.fg("muted", GLYPH.pending)} ${theme.fg("muted", "no todos")}`;
      }

      const done = todos.filter((todo) => todo.status === "completed").length;
      const header =
        `${theme.fg("success", GLYPH.ok)} ${progressBar(theme, done, todos.length)} ` +
        theme.fg("text", `${done}/${todos.length}`) +
        meta(theme, [firstMessage(firstText(result))]);

      // Unfinished work is what the reader needs; completed rows fill the rest.
      const open = todos.filter((todo) => todo.status !== "completed");
      const closed = todos.filter((todo) => todo.status === "completed");
      const ordered = [...open, ...closed];
      const limit = options.expanded ? ordered.length : Math.min(ordered.length, 6);
      const shown = ordered.slice(0, limit);

      let text = header;
      for (const todo of shown) text += `\n  ${todoLine(theme, todo)}`;

      const hidden = ordered.length - shown.length;
      if (hidden > 0) {
        const hiddenDone = shown.length >= open.length ? hidden : closed.length;
        text += theme.fg(
          "dim",
          `\n  +${hidden} more (${hiddenDone} completed) ${GLYPH.sep} ${safeKeyHint("app.tools.expand", "to expand")}`,
        );
      }
      return text;
    },
    oneLine(firstText(result), 120),
    context,
  );
}

/** The mutation message is the first line of the tool text ("Created #3: ..."). */
function firstMessage(text: string): string | undefined {
  const line = text.split("\n")[0]?.trim();
  if (!line || line.startsWith("Todos (")) return undefined;
  return oneLine(line, 48);
}

export interface WidgetOptions {
  collapsed: boolean;
  maxRows: number;
}

/**
 * Editor widget. Unfinished work sorts first, completed rows are struck
 * through, and anything dropped is accounted for on the overflow line.
 */
export function todoWidget(theme: Theme, state: TodoState, options: WidgetOptions): string[] {
  const todos = state.todos;
  if (todos.length === 0) return [];

  const done = todos.filter((todo) => todo.status === "completed").length;
  const active = todos.find((todo) => todo.status === "in_progress");
  const heading =
    headingRule(theme, "Todos") +
    ` ${progressBar(theme, done, todos.length)} ${theme.fg("muted", `${done}/${todos.length}`)}`;

  if (options.collapsed) {
    const hint = active ? oneLine(active.content, 40) : `${todos.length - done} remaining`;
    return [`${heading}  ${theme.fg("dim", `${GLYPH.sep} ${hint} ${GLYPH.sep} ${safeKeyHint("app.tools.expand", "expand")}`)}`];
  }

  const open = todos.filter((todo) => todo.status !== "completed");
  const closed = todos.filter((todo) => todo.status === "completed");
  const ordered = [...open, ...closed];
  const rows = Math.max(1, options.maxRows);
  const shown = ordered.slice(0, rows);

  const lines = [heading, ...shown.map((todo) => `  ${todoLine(theme, todo, 52)}`)];
  const hidden = ordered.slice(rows);
  if (hidden.length > 0) {
    // Say exactly what was dropped rather than a bare "+N more".
    const hiddenDone = hidden.filter((todo) => todo.status === "completed").length;
    const hiddenOpen = hidden.length - hiddenDone;
    const parts = [hiddenDone > 0 && `${hiddenDone} completed`, hiddenOpen > 0 && `${hiddenOpen} pending`].filter(
      (part): part is string => Boolean(part),
    );
    lines.push(theme.fg("dim", `  +${hidden.length} more (${parts.join(", ")})`));
  }
  return lines;
}

/** `/todos` output, grouped by status. */
export function formatTodosGrouped(todos: TodoItem[]): string {
  if (todos.length === 0) return "No todos yet. Ask the agent to plan the work.";
  const groups: Array<[string, TodoItem["status"]]> = [
    ["In progress", "in_progress"],
    ["Blocked", "blocked"],
    ["Pending", "pending"],
    ["Completed", "completed"],
    ["Abandoned", "abandoned"],
  ];
  const done = todos.filter((todo) => todo.status === "completed").length;
  const out: string[] = [`Todos ${done}/${todos.length} completed`];
  for (const [label, status] of groups) {
    const rows = todos.filter((todo) => todo.status === status);
    if (rows.length === 0) continue;
    out.push("", `${label} (${rows.length})`);
    for (const todo of rows) {
      const details = [
        todo.phase && `phase ${todo.phase}`,
        todo.blocker && `blocked: ${todo.blocker}`,
        todo.blockedBy?.length && `needs ${todo.blockedBy.map((id) => `#${id}`).join(",")}`,
      ].filter((part): part is string => Boolean(part));
      out.push(`  ${STATUS_GLYPH[todo.status]} #${todo.id} ${todo.content}${details.length ? `  ${details.join("; ")}` : ""}`);
    }
  }
  return out.join("\n");
}
