# pi-essentials

Pi Coding Agent extension (MCP, web, subagents, todos, questions). Not a standalone app. Do not wrap `pi-mcp-adapter`, `pi-web-access`, or juicesharp packages; this is an original, smaller surface. No Agent Hub, no browser automation, no binary `web_fetch`.

## Commands

Node 22+, npm (`package-lock.json`). No build, lint, or format step — `main` / `exports` / `pi.extensions` point at TypeScript source.

```bash
npm ci
npm run check          # tsc --noEmit && vitest run (what CI and PRs expect)
npm run typecheck
npm test
npx vitest run tests/<file>.test.ts
```

CI order: `typecheck` then `test`. Load a local checkout with `pi install /absolute/path/to/pi-essentials`, then restart Pi or `/reload`.

## Layout

`src/index.ts` default-exports `piEssentials(pi: ExtensionAPI)` and registers independent modules:

| Module | Dir | Tools |
|---|---|---|
| MCP | `src/mcp/` | `mcp` |
| Web | `src/web/` | `web_search`, `web_fetch` |
| Subagents | `src/subagents/` | `subagent` |
| Todos | `src/todos/` | `todo` |
| Questions | `src/questions/` | `ask_user_question` |

Shared code only: `src/config.ts`, `src/errors.ts`, `src/paths.ts`, `src/security/`, `src/ui/render.ts`. Caps live in `src/security/limits.ts`. Tool parameter schemas use `typebox` (`Type`) and `StringEnum` from `@earendil-works/pi-ai`.

Model-facing tool docs: `skills/pi-essentials/SKILL.md`. Keep that file in sync when tool APIs change.

## Invariants agents miss

- Relative imports must include `.ts`. Use `import type` (`verbatimModuleSyntax`). `noUnusedLocals` / `noUnusedParameters` are on.
- Tool failures **throw** (`toolFailure` / `PiEssentialsError`). Pi sets `isError` only on throw; returning `"Error: …"` prose is a bug.
- Never `console.log`/`warn` during extension load — it corrupts the TUI. Defer warnings to `session_start` via `ctx.ui.notify`.
- `PI_ESSENTIALS_SUBAGENT=1` skips MCP, todos, and questions. Nested `subagent` only if `allowNested` and depth `< MAX_NEST_DEPTH` (2).
- Spawn with argv arrays only (`node:child_process.spawn`). No `eval`, no `shell: true`, no `!cmd` interpolation. MCP env interpolation is `${VAR}` / `$env:VAR` only.
- Outbound HTTP goes through `safeFetch` (`src/web/http.ts`) + SSRF pinning (`src/security/ssrf.ts`). Do not use raw `fetch` for untrusted URLs. Loopback/private hosts stay blocked unless listed in `web.allowedHosts` (exact `host` or `host:port`).
- Subagent env is `sanitizeEnv`: strip `MCP_*` / `*_TOKEN` / `*_SECRET` / third-party `*_API_KEY`; keep pi provider credentials. Children are `pi --mode json --no-session`.
- UI: one compact row per tool (`src/ui/render.ts` `GLYPH` / `titleLine` / `meta`). Detail is expand-on-demand, not printed by default.
- Do not leak secrets, headers, or env values in errors or tool text.
- Justify any new runtime dependency. Do not add install/postinstall scripts.

## Tests

Vitest, `tests/**/*.test.ts`, 15s timeout. No live internet.

- Point `PI_CODING_AGENT_DIR` at a `mkdtempSync` dir so OAuth/cache/config stay off `$HOME`.
- Loopback fetch tests must allowlist the exact `127.0.0.1:<port>`.
- Mock `ExtensionAPI` with `registerTool` / `registerCommand` / `registerShortcut` / `on`.
- Render tests use an identity theme (plain text, not ANSI).
