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

## Web

- `web_search` for discovery, `web_fetch` for a specific URL.
- If fetch is truncated, use the returned `cacheId` with `offset`/`limit`.

## Subagents

- `scout` for recon, `worker` to implement, `reviewer` to check, `oracle` for a second opinion.
- Pass only the task. Do not paste the entire parent transcript.

## Todos

- `todo` for multi-step work. Keep at most one item `in_progress`.

## Questions

- `ask_user_question` only when a genuine user decision is required.
- Do not ask questions you can answer from the repo or with `web_search`.
