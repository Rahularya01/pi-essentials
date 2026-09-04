import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { errorMessage, toolFailure, toolText } from "../errors.ts";
import { MAX_TODOS } from "../security/limits.ts";
import { formatTodosGrouped, renderTodoCall, renderTodoResult, todoWidget } from "./render.ts";
import { applyTodoMutation, cloneState, emptyTodoState, formatTodos, type TodoItem, type TodoState } from "./state.ts";

interface TodoDetails {
  todos: TodoState["todos"];
  nextId: number;
}

/** Rows shown in the editor widget before it collapses into a "+N more" line. */
const WIDGET_ROWS = 8;
const TODO_STATE_ENTRY = "pi-essentials-todos";

export function registerTodos(pi: ExtensionAPI): void {
  const bySession = new Map<string, TodoState>();
  let collapsed = false;

  const sessionKey = (ctx: ExtensionContext): string =>
    ctx.sessionManager?.getSessionFile?.() || ctx.sessionManager?.getSessionId?.() || "default";

  /**
   * Rebuild state from the session branch so todos survive /reload, compaction,
   * and /tree navigation, which can move to a branch with different history.
   */
  const reconstruct = (ctx: ExtensionContext): TodoState => {
    let state = emptyTodoState();
    let branch: unknown[] = [];
    try {
      branch = ctx.sessionManager?.getBranch?.() ?? [];
    } catch {
      branch = [];
    }
    for (const entry of branch) {
      const record = entry as { type?: string; customType?: string; data?: Partial<TodoDetails>; message?: unknown };
      if (record?.type === "custom" && record.customType === TODO_STATE_ENTRY) {
        if (Array.isArray(record.data?.todos) && typeof record.data?.nextId === "number") {
          state = { todos: record.data.todos, nextId: record.data.nextId };
        }
        continue;
      }
      if (record?.type !== "message") continue;
      const msg = record.message as { role?: string; toolName?: string; details?: Partial<TodoDetails> };
      if (msg?.role !== "toolResult" || msg.toolName !== "todo") continue;
      if (Array.isArray(msg.details?.todos) && typeof msg.details?.nextId === "number") {
        state = { todos: msg.details.todos, nextId: msg.details.nextId };
      }
    }
    const restored = cloneState(state);
    bySession.set(sessionKey(ctx), restored);
    return restored;
  };

  const current = (ctx: ExtensionContext): TodoState => bySession.get(sessionKey(ctx)) ?? reconstruct(ctx);

  const renderWidget = (ctx: ExtensionContext, state: TodoState) => {
    if (!ctx.hasUI) return;
    if (state.todos.length === 0) {
      ctx.ui.setWidget("pi-essentials-todos", undefined);
      return;
    }
    // A component factory receives the live theme, so the widget picks up
    // strikethrough, the progress meter, and theme colors.
    ctx.ui.setWidget(
      "pi-essentials-todos",
      (_tui, theme) => new Text(todoWidget(theme, state, { collapsed, maxRows: WIDGET_ROWS }).join("\n"), 0, 0),
      { placement: "aboveEditor" },
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    bySession.clear();
    renderWidget(ctx, reconstruct(ctx));
  });
  pi.on("session_tree", async (_event, ctx) => {
    renderWidget(ctx, reconstruct(ctx));
  });
  pi.on("session_shutdown", async () => {
    bySession.clear();
  });

  pi.registerShortcut("ctrl+shift+t", {
    description: "Collapse or expand the pi-essentials todo panel",
    handler: async (ctx) => {
      collapsed = !collapsed;
      renderWidget(ctx, current(ctx));
    },
  });

  pi.registerCommand("todos", {
    description: "Show the current todo list. Usage: /todos [clear]",
    handler: async (args, ctx) => {
      if (args.trim().toLowerCase() === "clear") {
        const applied = applyTodoMutation(current(ctx), { action: "clear" });
        bySession.set(sessionKey(ctx), applied.state);
        pi.appendEntry(TODO_STATE_ENTRY, cloneState(applied.state));
        renderWidget(ctx, applied.state);
        ctx.ui.notify(applied.message, "info");
        return;
      }
      ctx.ui.notify(formatTodosGrouped(current(ctx).todos), "info");
    },
  });

  const StatusSchema = StringEnum(["pending", "in_progress", "completed", "blocked", "abandoned"] as const);
  const SnapshotTodoSchema = Type.Object({
    id: Type.Integer({ minimum: 1, description: "Stable numeric todo id" }),
    content: Type.String(),
    status: StatusSchema,
    blockedBy: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
    phase: Type.Optional(Type.String()),
    blocker: Type.Optional(Type.String()),
  });

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Track multi-step coding work. Actions: list, create, update, complete, reopen, block, unblock, abandon, delete, clear, sync. Keep at most one item in_progress.",
    promptSnippet: "Track multi-step work with a structured todo list",
    promptGuidelines: [
      "Use todo to plan and track multi-step coding tasks instead of keeping an informal checklist only in your head.",
      "Keep at most one todo in_progress. Mark work complete as soon as it is done.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "create", "update", "complete", "reopen", "block", "unblock", "abandon", "delete", "clear", "sync"] as const),
      content: Type.Optional(Type.String({ description: "Todo text for create/update" })),
      id: Type.Optional(Type.Number({ description: "Todo id for update/complete/reopen/block/unblock/abandon/delete" })),
      status: Type.Optional(StatusSchema),
      blockedBy: Type.Optional(Type.Array(Type.Number(), { description: `Ids that must finish first (max ${MAX_TODOS})` })),
      phase: Type.Optional(Type.String({ description: "Optional workflow phase" })),
      blocker: Type.Optional(Type.String({ description: "Optional reason the todo is blocked" })),
      todos: Type.Optional(Type.Array(SnapshotTodoSchema, { description: "Complete replacement snapshot for sync" })),

    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const before = current(ctx);
      try {
        const applied = applyTodoMutation(before, {
          action: params.action,
          content: params.content,
          id: params.id,
          status: params.status,
          blockedBy: params.blockedBy,
          phase: params.phase,
          blocker: params.blocker,
          todos: params.todos as TodoItem[] | undefined,
        });
        bySession.set(sessionKey(ctx), applied.state);
        renderWidget(ctx, applied.state);
        const listing = params.action === "list" ? "" : `\n\n${formatTodos(applied.state.todos)}`;
        return toolText(`${applied.message}${listing}`, {
          todos: applied.state.todos,
          nextId: applied.state.nextId,
          action: params.action,
        } satisfies TodoDetails & { action: string });
      } catch (error) {
        // The state is unchanged on failure, so the last successful result is
        // still the correct one for branch reconstruction.
        toolFailure(`${errorMessage(error)}\n\n${formatTodos(before.todos)}`, "TODO_INVALID");
      }
    },
    renderCall: renderTodoCall,
    renderResult: renderTodoResult,
  });
}
