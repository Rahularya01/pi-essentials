import { MAX_TODOS } from "../security/limits.ts";

export type TodoStatus = "pending" | "in_progress" | "completed" | "blocked" | "abandoned";

export interface TodoItem {
  id: number;
  content: string;
  status: TodoStatus;
  blockedBy?: number[];
  phase?: string;
  blocker?: string;
}

export interface TodoState {
  todos: TodoItem[];
  nextId: number;
}

export type TodoAction =
  | "list"
  | "create"
  | "update"
  | "complete"
  | "reopen"
  | "delete"
  | "clear"
  | "block"
  | "unblock"
  | "abandon"
  | "sync";

export interface TodoMutation {
  action: TodoAction;
  content?: string;
  id?: number;
  status?: TodoStatus;
  blockedBy?: number[];
  phase?: string;
  blocker?: string;
  todos?: TodoItem[];
}

const STATUSES = new Set<TodoStatus>(["pending", "in_progress", "completed", "blocked", "abandoned"]);

export function emptyTodoState(): TodoState {
  return { todos: [], nextId: 1 };
}

export function cloneState(state: TodoState): TodoState {
  return {
    nextId: state.nextId,
    todos: state.todos.map((todo) => ({ ...todo, blockedBy: todo.blockedBy ? [...todo.blockedBy] : undefined })),
  };
}

export function applyTodoMutation(state: TodoState, mutation: TodoMutation): { state: TodoState; message: string } {
  const next = cloneState(state);
  switch (mutation.action) {
    case "list":
      return { state: next, message: formatTodos(next.todos) };
    case "sync": {
      const synced = validateSnapshot(mutation.todos);
      return {
        state: { todos: synced, nextId: synced.reduce((max, todo) => Math.max(max, todo.id), 0) + 1 },
        message: `Synced ${synced.length} todo(s).`,
      };
    }
    case "create": {
      const content = mutation.content?.trim();
      if (!content) throw new Error("content is required to create a todo");
      if (next.todos.length >= MAX_TODOS) {
        throw new Error(`Todo limit reached (${MAX_TODOS} total); delete or clear todos before creating another.`);
      }
      const status = mutation.status ?? "pending";
      assertStatus(status);
      const blockedBy = normalizeBlockedBy(mutation.blockedBy, next.todos);
      const todo: TodoItem = {
        id: next.nextId++,
        content,
        status,
        blockedBy,
        phase: cleanOptional(mutation.phase),
        blocker: cleanOptional(mutation.blocker),
      };
      next.todos.push(todo);
      assertNoCycles(next.todos);
      const moved = ensureSingleInProgress(next, todo);
      return { state: next, message: `Created #${todo.id}: ${todo.content}${transitionNote(moved)}${warnings(next, todo)}` };
    }
    case "update": {
      const todo = requireTodo(next, mutation.id);
      const previous = todo.status;
      if (mutation.content?.trim()) todo.content = mutation.content.trim();
      if (mutation.status !== undefined) {
        assertStatus(mutation.status);
        todo.status = mutation.status;
      }
      if (mutation.blockedBy !== undefined) todo.blockedBy = normalizeBlockedBy(mutation.blockedBy, next.todos, todo.id);
      if (mutation.phase !== undefined) todo.phase = cleanOptional(mutation.phase);
      if (mutation.blocker !== undefined) todo.blocker = cleanOptional(mutation.blocker);
      assertNoCycles(next.todos);
      const moved = ensureSingleInProgress(next, todo);
      const changed = previous !== todo.status ? ` (${previous} → ${todo.status})` : "";
      return {
        state: next,
        message: `Updated #${todo.id}: ${todo.content} [${todo.status}]${changed}${transitionNote(moved)}${warnings(next, todo)}`,
      };
    }
    case "complete": {
      const todo = requireTodo(next, mutation.id);
      if (todo.status === "completed") return { state: next, message: `#${todo.id} was already completed.` };
      const previous = todo.status;
      todo.status = "completed";
      const unblocked = newlyDependencyReady(next, todo.id);
      return {
        state: next,
        message: `Completed #${todo.id}: ${todo.content} (${previous} → completed).${unblockedNote(unblocked)}`,
      };
    }
    case "reopen": {
      const todo = requireTodo(next, mutation.id);
      const previous = todo.status;
      todo.status = "pending";
      return { state: next, message: `Reopened #${todo.id}: ${todo.content} (${previous} → pending)` };
    }
    case "block": {
      const todo = requireTodo(next, mutation.id);
      const previous = todo.status;
      todo.status = "blocked";
      if (mutation.blocker !== undefined) todo.blocker = cleanOptional(mutation.blocker);
      const reason = todo.blocker ? ` — ${todo.blocker}` : "";
      return { state: next, message: `Blocked #${todo.id}: ${todo.content} (${previous} → blocked)${reason}` };
    }
    case "unblock": {
      const todo = requireTodo(next, mutation.id);
      const previous = todo.status;
      todo.status = "pending";
      todo.blocker = undefined;
      const dependencies = isReady(next, todo) ? "" : ` Still waiting on ${unmetDependencies(next, todo).map((id) => `#${id}`).join(", ")}.`;
      return { state: next, message: `Unblocked #${todo.id}: ${todo.content} (${previous} → pending).${dependencies}` };
    }
    case "abandon": {
      const todo = requireTodo(next, mutation.id);
      if (todo.status === "abandoned") return { state: next, message: `#${todo.id} was already abandoned.` };
      const previous = todo.status;
      todo.status = "abandoned";
      return { state: next, message: `Abandoned #${todo.id}: ${todo.content} (${previous} → abandoned).` };
    }
    case "delete": {
      const todo = requireTodo(next, mutation.id);
      next.todos = next.todos.filter((item) => item.id !== todo.id);
      for (const item of next.todos) {
        if (item.blockedBy) item.blockedBy = item.blockedBy.filter((id) => id !== todo.id);
      }
      return { state: next, message: `Deleted #${todo.id}` };
    }
    case "clear": {
      const count = next.todos.length;
      next.todos = [];
      next.nextId = 1;
      return { state: next, message: `Cleared ${count} todo(s)` };
    }
    default:
      throw new Error(`Unknown todo action: ${String(mutation.action)}`);
  }
}

/** A todo is dependency-ready when every dependency it lists is completed. */
export function isReady(state: TodoState, todo: TodoItem): boolean {
  return unmetDependencies(state, todo).length === 0;
}

function unmetDependencies(state: TodoState, todo: TodoItem): number[] {
  return (todo.blockedBy ?? []).filter(
    (id) => state.todos.find((item) => item.id === id)?.status !== "completed",
  );
}

/** Moving work in progress is atomic: the previous active item returns to pending. */
function ensureSingleInProgress(state: TodoState, selected: TodoItem): TodoItem[] {
  if (selected.status !== "in_progress") return [];
  const moved = state.todos.filter((todo) => todo.id !== selected.id && todo.status === "in_progress");
  for (const todo of moved) todo.status = "pending";
  return moved;
}

function transitionNote(moved: TodoItem[]): string {
  return moved.length > 0 ? ` Moved ${moved.map((todo) => `#${todo.id}`).join(", ")} back to pending.` : "";
}

function newlyDependencyReady(state: TodoState, completedId: number): TodoItem[] {
  return state.todos.filter(
    (item) => item.status !== "completed" && item.status !== "abandoned" && item.blockedBy?.includes(completedId) && isReady(state, item),
  );
}

function unblockedNote(todos: TodoItem[]): string {
  const ready = todos.filter((todo) => todo.status !== "blocked");
  const explicitlyBlocked = todos.filter((todo) => todo.status === "blocked");
  const parts: string[] = [];
  if (ready.length > 0) parts.push(`Unblocked: ${ready.map((item) => `#${item.id}`).join(", ")} (dependencies complete).`);
  if (explicitlyBlocked.length > 0) {
    parts.push(`Dependencies complete for ${explicitlyBlocked.map((item) => `#${item.id}`).join(", ")}; explicit blocker remains.`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

/** Non-fatal advice appended to a mutation message so the model self-corrects. */
function warnings(state: TodoState, todo: TodoItem): string {
  if (todo.status !== "in_progress" || isReady(state, todo)) return "";
  return ` (Warning: still blocked by ${unmetDependencies(state, todo).map((id) => `#${id}`).join(", ")}.)`;
}

export function formatTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return "No todos.";
  const done = todos.filter((t) => t.status === "completed").length;
  const state: TodoState = { todos, nextId: 0 };
  const lines = [`Todos (${done}/${todos.length} completed)`];
  for (const todo of todos) {
    const mark = todo.status === "completed" ? "x" : todo.status === "in_progress" ? "~" : todo.status === "abandoned" ? "-" : todo.status === "blocked" ? "!" : " ";
    const dependencies = todo.blockedBy?.length
      ? ` ${isReady(state, todo) ? "was-blocked-by" : "blocked-by"}=${todo.blockedBy.join(",")}`
      : "";
    const phase = todo.phase ? ` phase=${todo.phase}` : "";
    const blocker = todo.blocker ? ` blocker=${todo.blocker}` : "";
    lines.push(`[${mark}] #${todo.id} ${todo.content} (${todo.status}${dependencies}${phase}${blocker})`);
  }
  return lines.join("\n");
}

function requireTodo(state: TodoState, id?: number): TodoItem {
  if (id === undefined) throw new Error("id is required");
  const todo = state.todos.find((item) => item.id === id);
  if (!todo) throw new Error(`Todo #${id} not found`);
  return todo;
}

function cleanOptional(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned || undefined;
}

function assertStatus(status: string): asserts status is TodoStatus {
  if (!STATUSES.has(status as TodoStatus)) throw new Error(`Invalid todo status: ${status}`);
}

function normalizeBlockedBy(blockedBy: number[] | undefined, todos: TodoItem[], selfId?: number): number[] | undefined {
  if (!blockedBy || blockedBy.length === 0) return undefined;
  const ids = [...new Set(blockedBy)];
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0) throw new Error("blockedBy ids must be positive integers");
    if (selfId !== undefined && id === selfId) throw new Error("A todo cannot block itself");
    if (!todos.some((todo) => todo.id === id)) throw new Error(`blockedBy references missing todo #${id}`);
  }
  if (selfId !== undefined) {
    assertNoCycles(todos.map((todo) => (todo.id === selfId ? { ...todo, blockedBy: ids } : todo)));
  }
  return ids;
}

/** Validate and clone a complete snapshot before any state is replaced. */
export function validateSnapshot(todos: TodoItem[] | undefined): TodoItem[] {
  if (!Array.isArray(todos)) throw new Error("todos is required for sync");
  if (todos.length > MAX_TODOS) throw new Error(`Todo snapshot exceeds the ${MAX_TODOS} total todo limit.`);

  const ids = new Set<number>();
  let active = 0;
  const cloned = todos.map((todo, index): TodoItem => {
    if (!todo || !Number.isInteger(todo.id) || todo.id <= 0) throw new Error(`Todo ${index + 1} id must be a positive integer`);
    if (ids.has(todo.id)) throw new Error(`Duplicate todo id #${todo.id}`);
    ids.add(todo.id);
    const content = typeof todo.content === "string" ? todo.content.trim() : "";
    if (!content) throw new Error(`Todo #${todo.id} content cannot be empty`);
    assertStatus(todo.status);
    if (todo.status === "in_progress" && ++active > 1) throw new Error("Only one todo may be in_progress");
    if (todo.phase !== undefined && typeof todo.phase !== "string") throw new Error(`Todo #${todo.id} phase must be a string`);
    if (todo.blocker !== undefined && typeof todo.blocker !== "string") throw new Error(`Todo #${todo.id} blocker must be a string`);
    if (todo.blockedBy !== undefined && !Array.isArray(todo.blockedBy)) throw new Error(`Todo #${todo.id} blockedBy must be an array`);
    return {
      id: todo.id,
      content,
      status: todo.status,
      blockedBy: todo.blockedBy?.length ? [...new Set(todo.blockedBy)] : undefined,
      phase: cleanOptional(todo.phase),
      blocker: cleanOptional(todo.blocker),
    };
  });

  for (const todo of cloned) todo.blockedBy = normalizeBlockedBy(todo.blockedBy, cloned, todo.id);
  assertNoCycles(cloned);
  return cloned;
}

export function assertNoCycles(todos: TodoItem[]): void {
  const byId = new Map(todos.map((todo) => [todo.id, todo]));
  const visiting = new Set<number>();
  const visited = new Set<number>();

  const visit = (id: number): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error("blockedBy contains a cycle");
    visiting.add(id);
    const todo = byId.get(id);
    for (const dep of todo?.blockedBy ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };

  for (const todo of todos) visit(todo.id);
}
