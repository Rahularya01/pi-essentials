export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: number;
  content: string;
  status: TodoStatus;
  blockedBy?: number[];
}

export interface TodoState {
  todos: TodoItem[];
  nextId: number;
}

export type TodoAction = "list" | "create" | "update" | "complete" | "reopen" | "delete" | "clear";

export interface TodoMutation {
  action: TodoAction;
  content?: string;
  id?: number;
  status?: TodoStatus;
  blockedBy?: number[];
}

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
    case "create": {
      const content = mutation.content?.trim();
      if (!content) throw new Error("content is required to create a todo");
      if (next.todos.length >= 40) throw new Error("Too many todos (max 40). Complete or delete some first.");
      const blockedBy = normalizeBlockedBy(mutation.blockedBy, next.todos);
      const todo: TodoItem = { id: next.nextId++, content, status: "pending", blockedBy };
      next.todos.push(todo);
      assertNoCycles(next.todos);
      return { state: next, message: `Created #${todo.id}: ${todo.content}` };
    }
    case "update": {
      const todo = requireTodo(next, mutation.id);
      if (mutation.content?.trim()) todo.content = mutation.content.trim();
      if (mutation.status) todo.status = mutation.status;
      if (mutation.blockedBy) todo.blockedBy = normalizeBlockedBy(mutation.blockedBy, next.todos, todo.id);
      assertNoCycles(next.todos);
      return { state: next, message: `Updated #${todo.id}: ${todo.content} [${todo.status}]` };
    }
    case "complete": {
      const todo = requireTodo(next, mutation.id);
      todo.status = "completed";
      return { state: next, message: `Completed #${todo.id}: ${todo.content}` };
    }
    case "reopen": {
      const todo = requireTodo(next, mutation.id);
      todo.status = "pending";
      return { state: next, message: `Reopened #${todo.id}: ${todo.content}` };
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

export function formatTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return "No todos.";
  const done = todos.filter((t) => t.status === "completed").length;
  const lines = [`Todos (${done}/${todos.length} completed)`];
  for (const todo of todos) {
    const mark = todo.status === "completed" ? "x" : todo.status === "in_progress" ? "~" : " ";
    const blocked = todo.blockedBy?.length ? ` blockedBy=${todo.blockedBy.join(",")}` : "";
    lines.push(`[${mark}] #${todo.id} ${todo.content} (${todo.status}${blocked})`);
  }
  return lines.join("\n");
}

function requireTodo(state: TodoState, id?: number): TodoItem {
  if (id === undefined) throw new Error("id is required");
  const todo = state.todos.find((item) => item.id === id);
  if (!todo) throw new Error(`Todo #${id} not found`);
  return todo;
}

function normalizeBlockedBy(blockedBy: number[] | undefined, todos: TodoItem[], selfId?: number): number[] | undefined {
  if (!blockedBy || blockedBy.length === 0) return undefined;
  const ids = [...new Set(blockedBy)];
  for (const id of ids) {
    if (selfId !== undefined && id === selfId) throw new Error("A todo cannot block itself");
    if (!todos.some((todo) => todo.id === id)) throw new Error(`blockedBy references missing todo #${id}`);
  }
  const next = todos.map((todo) => (todo.id === selfId ? { ...todo, blockedBy: ids } : todo));
  if (selfId === undefined) {
    // creating: the new todo is not in the list yet; cycle check happens after insert in create
  } else {
    assertNoCycles(next);
  }
  return ids;
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
