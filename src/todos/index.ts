import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toolError, toolText } from "../errors.ts";
import { applyTodoMutation, cloneState, emptyTodoState, formatTodos, type TodoState } from "./state.ts";

interface TodoDetails {
  todos: TodoState["todos"];
  nextId: number;
}

export function registerTodos(pi: ExtensionAPI): void {
  const bySession = new Map<string, TodoState>();

  const sessionKey = (ctx: ExtensionContext): string => {
    return ctx.sessionManager.getSessionFile() || ctx.sessionManager.getSessionId() || "default";
  };

  const reconstruct = (ctx: ExtensionContext): TodoState => {
    let state = emptyTodoState();
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    for (const entry of branch) {
      if (entry?.type !== "message") continue;
      const msg = entry.message as { role?: string; toolName?: string; details?: TodoDetails };
      if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
      if (msg.details?.todos && typeof msg.details.nextId === "number") {
        state = { todos: msg.details.todos, nextId: msg.details.nextId };
      }
    }
    bySession.set(sessionKey(ctx), cloneState(state));
    return state;
  };

  const current = (ctx: ExtensionContext): TodoState => bySession.get(sessionKey(ctx)) ?? reconstruct(ctx);

  const renderWidget = (ctx: ExtensionContext, state: TodoState) => {
    if (!ctx.hasUI) return;
    if (state.todos.length === 0) {
      ctx.ui.setWidget("pi-essentials-todos", undefined);
      return;
    }
    const done = state.todos.filter((t) => t.status === "completed").length;
    const lines = [`Todos (${done}/${state.todos.length})`];
    for (const todo of state.todos.slice(0, 8)) {
      const mark = todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "▶" : "○";
      lines.push(`${mark} #${todo.id} ${todo.content}`);
    }
    if (state.todos.length > 8) lines.push(`+${state.todos.length - 8} more`);
    ctx.ui.setWidget("pi-essentials-todos", lines);
  };

  pi.on("session_start", async (_event, ctx) => {
    renderWidget(ctx, reconstruct(ctx));
  });
  pi.on("session_tree", async (_event, ctx) => {
    renderWidget(ctx, reconstruct(ctx));
  });

  pi.registerCommand("todos", {
    description: "Show the current todo list",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatTodos(current(ctx).todos), "info");
    },
  });

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Track multi-step coding work. Actions: list, create, update, complete, reopen, delete, clear. Keep at most one item in_progress.",
    promptSnippet: "Track multi-step work with a structured todo list",
    promptGuidelines: [
      "Use todo to plan and track multi-step coding tasks instead of keeping an informal checklist only in your head.",
      "Keep at most one todo in_progress. Mark work complete as soon as it is done.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "create", "update", "complete", "reopen", "delete", "clear"] as const),
      content: Type.Optional(Type.String({ description: "Todo text for create/update" })),
      id: Type.Optional(Type.Number({ description: "Todo id for update/complete/reopen/delete" })),
      status: Type.Optional(StringEnum(["pending", "in_progress", "completed"] as const)),
      blockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Ids that must finish first" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const applied = applyTodoMutation(current(ctx), {
          action: params.action,
          content: params.content,
          id: params.id,
          status: params.status,
          blockedBy: params.blockedBy,
        });
        bySession.set(sessionKey(ctx), applied.state);
        renderWidget(ctx, applied.state);
        return toolText(applied.message + (params.action === "list" ? "" : `\n\n${formatTodos(applied.state.todos)}`), {
          todos: applied.state.todos,
          nextId: applied.state.nextId,
          action: params.action,
        } satisfies TodoDetails & { action: string });
      } catch (error) {
        const state = current(ctx);
        return toolError(error instanceof Error ? error.message : String(error), {
          todos: state.todos,
          nextId: state.nextId,
        });
      }
    },
  });
}
