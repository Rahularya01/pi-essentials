import { describe, expect, it, vi } from "vitest";
import { askQuestions } from "../src/questions/ask.ts";
import { validateQuestions } from "../src/questions/validate.ts";
import { MAX_TODOS } from "../src/security/limits.ts";
import { applyTodoMutation, emptyTodoState } from "../src/todos/state.ts";

describe("OMP-compatible todos", () => {
  it("syncs a complete snapshot, preserves metadata, and derives nextId", () => {
    const result = applyTodoMutation(emptyTodoState(), {
      action: "sync",
      todos: [
        { id: 4, content: "Design", status: "completed", phase: "plan" },
        { id: 9, content: "Build", status: "blocked", blocker: "waiting", blockedBy: [4] },
      ],
    });
    expect(result.state.nextId).toBe(10);
    expect(result.state.todos[1]).toMatchObject({ phase: undefined, blocker: "waiting", blockedBy: [4] });
  });

  it("rejects an invalid sync atomically", () => {
    const original = applyTodoMutation(emptyTodoState(), { action: "create", content: "Existing" }).state;
    const before = structuredClone(original);
    expect(() =>
      applyTodoMutation(original, {
        action: "sync",
        todos: [
          { id: 1, content: "A", status: "pending", blockedBy: [2] },
          { id: 2, content: "B", status: "pending", blockedBy: [1] },
        ],
      }),
    ).toThrow(/cycle/);
    expect(original).toEqual(before);
  });

  it("validates snapshot ids, references, content, and one active todo", () => {
    const sync = (todos: Parameters<typeof applyTodoMutation>[1]["todos"]) =>
      applyTodoMutation(emptyTodoState(), { action: "sync", todos });
    expect(() => sync([{ id: 0, content: "A", status: "pending" }])).toThrow(/positive/);
    expect(() => sync([{ id: 1, content: " ", status: "pending" }])).toThrow(/content/);
    expect(() => sync([
      { id: 1, content: "A", status: "pending" },
      { id: 1, content: "B", status: "pending" },
    ])).toThrow(/Duplicate/);
    expect(() => sync([{ id: 1, content: "A", status: "unknown" as never }])).toThrow(/Invalid.*status/);
    expect(() => sync(Array.from({ length: MAX_TODOS + 1 }, (_, index) => ({
      id: index + 1,
      content: `T${index}`,
      status: "pending" as const,
    })))).toThrow(/total todo limit/);
    expect(() => sync([{ id: 1, content: "A", status: "pending", blockedBy: [2] }])).toThrow(/missing/);
    expect(() => sync([
      { id: 1, content: "A", status: "in_progress" },
      { id: 2, content: "B", status: "in_progress" },
    ])).toThrow(/Only one/);
  });

  it("supports explicit block, unblock, and abandon transitions", () => {
    let state = applyTodoMutation(emptyTodoState(), { action: "create", content: "Ship", phase: "release" }).state;
    state = applyTodoMutation(state, { action: "block", id: 1, blocker: "CI is down" }).state;
    expect(state.todos[0]).toMatchObject({ status: "blocked", phase: "release", blocker: "CI is down" });
    state = applyTodoMutation(state, { action: "unblock", id: 1 }).state;
    expect(state.todos[0]).toMatchObject({ status: "pending", blocker: undefined });
    state = applyTodoMutation(state, { action: "abandon", id: 1 }).state;
    expect(state.todos[0]?.status).toBe("abandoned");
  });
});

describe("OMP-compatible questions", () => {
  it("validates aliases and recommended indices", () => {
    const base = { question: "Pick", options: [{ label: "A" }, { label: "B" }] };
    expect(validateQuestions([{ ...base, multiple: true }])).toBeUndefined();
    expect(validateQuestions([{ ...base, multiple: true, multiSelect: false }])).toMatch(/conflicting/);
    expect(validateQuestions([{ ...base, recommended: 2 }])).toMatch(/zero-based/);
  });

  it("returns ids, values, and indices while passing the abort signal", async () => {
    const signal = new AbortController().signal;
    const select = vi.fn().mockResolvedValue("2. PostgreSQL — Durable");
    const ctx = { hasUI: true, ui: { select, input: vi.fn() } };
    const result = await askQuestions(ctx as never, [{
      id: "database",
      question: "Choose a database",
      options: [
        { label: "SQLite", value: "sqlite" },
        { label: "PostgreSQL", description: "Durable", value: "postgres" },
      ],
      allowOther: false,
      recommended: 1,
    }], signal);

    expect(result.answers[0]).toMatchObject({
      id: "database",
      selected: ["PostgreSQL"],
      selectedValues: ["postgres"],
      selectedIndices: [1],
    });
    expect(select).toHaveBeenCalledWith("Choose a database", ["1. SQLite", "2. PostgreSQL — Durable"], { signal });
  });
});
