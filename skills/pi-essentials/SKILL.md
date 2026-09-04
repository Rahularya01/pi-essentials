---
name: pi-essentials
description: Combined MCP, web, subagent, todo, and ask-user tools for the Pi Coding Agent. Use when the task needs external tools, web research, delegated agents, a task list, or a real user decision.
---

# pi-essentials

This session has a bundled plugin. Prefer these tools over inventing shell workarounds.

## MCP

- `mcp({ action: "search", query })` then `describe` then `call`.
- Do not assume every MCP tool is already in the tool list.
- If a server needs OAuth, `mcp({ action: "auth", server })`.
- `mcp({ action: "status" })` explains why a server has no tools.
- MCP calls include non-duplicated `structuredContent`. Use prefixed names when an original name is ambiguous; server `isError` results are tool failures.

## Web

- `web_search` for discovery, `web_fetch` for a specific URL.
- Search count aliases have precedence `numResults` → `limit` → `num_search_results` → configured default.
- Results are shown collapsed; there is no need to restate them back to the user.
- Pass exactly one of `url` or `cacheId` to `web_fetch`. For truncation, use the printed `cacheId` and `offset`.
- `web_fetch` reads text pages only. It will not download binaries or run page JavaScript.

## Subagents

- `scout` for recon, `worker` to implement, `reviewer` to check, `oracle` for a second opinion.
- Pass only the task. Do not paste the entire parent transcript.
- `{ tasks: [...] }` runs in parallel; `{ chain: [...] }` runs in order and substitutes `{previous}`.
- `outputSchema` requires a structured object result; a per-job schema overrides the top-level default.
- `isolation: "worktree"` requires a clean Git tree. It returns changed files and a patch artifact after removing the temporary checkout; it never auto-applies the patch. Parallel jobs are separate, while isolated chain steps share a worktree.
- The spawn budget is per session, so batch related work instead of spawning one child at a time.

## Todos

- `todo` supports `list/create/update/complete/reopen/block/unblock/abandon/delete/clear/sync` and statuses `pending/in_progress/completed/blocked/abandoned`.
- Keep at most one item `in_progress`; use `phase` for workflow grouping and `blocker` for an explicit blocking reason.
- Use `blockedBy` for real ordering constraints; the tool rejects cycles and missing ids.
- `sync` replaces the complete snapshot while preserving supplied IDs, dependencies, metadata, and statuses.
- The user sees a live panel above the editor, so keep todo text short and specific.

## Questions

- `ask_user_question` only when a genuine user decision is required.
- Do not ask questions you can answer from the repo or with `web_search`.
- Give 2-4 distinct options. `allowOther` defaults true; set it false only when free text is invalid.
- Use `id` for answer correlation and option `value` for machine-readable choices. `recommended` is validated zero-based metadata, not a preselection.
- `multiple` aliases `multiSelect` (both must agree). Answers include selected labels, values, indices, and custom text.
