# pi-essentials

[![CI](https://github.com/Rahularya01/pi-essentials/actions/workflows/ci.yml/badge.svg)](https://github.com/Rahularya01/pi-essentials/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Pi Coding Agent package that combines MCP, web access, subagents, todos, and structured user questions in one plugin.

Pi itself ships without these capabilities. `pi-essentials` registers them as a single extension with a shared config, shared limits, and independent modules. It does **not** wrap `pi-mcp-adapter`, `pi-web-access`, `pi-subagents`, or the juicesharp packages — it follows their proven patterns (proxy MCP tool, readability extraction, isolated child sessions, session-branch todos) with a smaller, security-first surface.

Compatibility is selective, not full OMP parity. This package does not provide Agent Hub or browser automation, and `web_fetch` does not download binary files.

## Install

From npm:

```bash
pi install npm:pi-essentials
```

From a local checkout:

```bash
pi install /absolute/path/to/pi-essentials
```

Or add it to `~/.pi/agent/settings.json` / `.pi/settings.json`:

```json
{
  "packages": ["npm:pi-essentials"]
}
```

Restart Pi, or run `/reload` if the package is already discovered.

Requires Node.js 22+ and Pi (`@earendil-works/pi-coding-agent`).

## Configuration

Create `~/.pi/agent/pi-essentials.json`, and optionally override it with `.pi/pi-essentials.json` in a project. Later files win. Malformed JSON is ignored with a warning.

```json
{
  "mcp": true,
  "web": true,
  "subagents": true,
  "todos": true,
  "questions": true
}
```

Disable one capability:

```json
{
  "mcp": false,
  "web": { "enabled": true, "search": { "provider": "auto", "braveApiKey": "BSA_..." } },
  "subagents": { "enabled": true, "maxConcurrency": 4, "spawnBudget": 16 },
  "todos": true,
  "questions": true
}
```

Files are merged key by key, so a project file can override a single nested option
(`web.search.maxResults`) without discarding the rest of the user file. Unknown keys
produce a startup warning instead of being silently dropped.

| Option | Default | Meaning |
|---|---|---|
| `mcp.requestTimeoutMs` | `30000` | Per-request MCP timeout |
| `mcp.idleTimeoutMs` | `600000` | Disconnect an idle MCP server after this long |
| `web.search.provider` | `"auto"` | Force one backend, or use the fallback chain |
| `web.search.timeoutMs` | `15000` | Per-request search timeout |
| `web.search.maxResults` | `5` | Default result count (1-20) |
| `web.fetch.timeoutMs` | `15000` | Per-request fetch timeout |
| `web.fetch.maxBytes` | `2097152` | Download cap before the page is cut short |
| `web.fetch.maxChars` | `32000` | Characters returned per call |
| `web.fetch.jinaFallback` | `true` | Retry a failed fetch through `r.jina.ai` |
| `web.allowedHosts` | `[]` | Private hosts to trust, as `host` or `host:port` |
| `subagents.maxConcurrency` | `4` | Children running at once in parallel mode |
| `subagents.maxParallel` | `8` | Tasks accepted in one parallel call |
| `subagents.maxOutputBytes` | `51200` | UTF-8 byte cap on each child's returned answer |
| `subagents.spawnBudget` | `16` | Children per session |
| `subagents.allowNested` | `false` | Let a child spawn its own children |

API keys may also come from `BRAVE_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`, `JINA_API_KEY`, and `SEARXNG_URL`.

See [`examples/pi-essentials.json`](examples/pi-essentials.json) and [`examples/pi-settings.json`](examples/pi-settings.json).

## Terminal UI

Every tool renders one compact row: what it did, then dimmed metadata. Detail is
available on demand with `ctrl+o` rather than printed by default.

```
web_search "typescript readable streams" · brave
✓ 4 results · brave
  1. Stream | Node.js v26 Documentation
     nodejs.org/api/stream.html
  2. Backpressure in Streams
     nodejs.org/en/learn/modules/backpressuring-in-streams
  +2 more results · ctrl+o to expand
```

```
subagent scout, reviewer · parallel ×2
✓ 1/2 finished · 18.4s · 14.5k→930 tok · $0.035
  ✓ scout · 18.4s · 4 turns
  ✗ reviewer · 4.2s · 1 turn · no API key
  ctrl+o to read the answers
```

Three panels sit around the editor and each collapses to a single line:

| Panel | Where | Toggle |
|---|---|---|
| Todos | above the editor | `ctrl+shift+t` |
| Subagent fleet | below the editor | `ctrl+shift+a` |
| Web activity | below the editor | `ctrl+shift+w` |

```
── Todos ───────────────────────────── ▪▪▪▪▫▫▫▫▫▫ 2/5
  ▶ #3 Wire the activity panel
  ○ #4 Update the README · needs #3
  ✓ #1 R̶e̶a̶d̶ ̶t̶h̶e̶ ̶d̶o̶c̶s̶
  +1 more (1 completed)

── Subagents ───────────────── 2 running · 5/16 spawned
  ⠹ scout    18.4s · Map the payment flow end to end
  ⠼ reviewer  4.2s · Review the new tests

── Web activity ───────────────────────────── 3 recent
  FETCH  blog.example.com/gone      HTTP 404       260ms ✗
  FETCH  nodejs.org/api/stream.html 194.8k chars   812ms ✓
  SEARCH "typescript streams"       brave · 5 hits  2.1s ✓
```

Panels appear only when they have something to say, and an overflow line names
what it dropped (`+2 more (1 completed, 1 pending)`) rather than hiding it
silently. A footer status shows MCP health: `⚡ mcp 2/3 · 1 need auth`.

## MCP

Reads standard MCP files, later winning:

1. `~/.config/mcp/mcp.json`
2. `~/.agents/mcp.json`
3. `~/.agents/mcp/mcp.json`
4. `~/.pi/agent/mcp.json`
5. `.mcp.json`
6. `.pi/mcp.json`

Supports stdio (`command`/`args`) and HTTP (`url`), with Streamable HTTP then SSE fallback. Servers are **lazy** by default: they start on first use and idle-disconnect. One proxy tool keeps MCP schemas out of the parent context.

```js
mcp({ action: "search", query: "screenshot" })
mcp({ action: "describe", tool: "chrome_devtools_take_screenshot" })
mcp({ action: "call", tool: "chrome_devtools_take_screenshot", args: { format: "png" } })
mcp({ action: "status" })
mcp({ action: "auth", server: "linear" })
```

Servers can share defaults through a `settings` block in the same file:

```json
{ "settings": { "requestTimeoutMs": 30000, "idleTimeout": 10 }, "mcpServers": { } }
```

Commands: `/mcp` (status table), `/mcp tools`, `/mcp reconnect [name]`, `/mcp auth <name>`, `/mcp disconnect [name]`. A footer entry tracks connection health while the session runs.

Tool discovery connects lazily and in parallel, and leaves healthy connections
alone. Calls include MCP `structuredContent` as formatted JSON, without repeating
it when the same JSON is already present in a text part. If an unprefixed tool
name exists on multiple servers, the call fails with the valid prefixed names;
server results marked `isError` are surfaced as real tool errors. Binary results
(screenshots, audio, blobs) are summarized rather than pasted into the parent
context as base64.

OAuth uses PKCE and a local loopback callback. Tokens are stored at `~/.pi/agent/pi-essentials/mcp-oauth.json` (mode `0600`) keyed by `{serverName, url}`. Bearer tokens and header env interpolation (`${VAR}`, `$env:VAR`) are supported. Command-substitution secrets (`!cmd`) are not.

Example server file: [`examples/mcp.json`](examples/mcp.json).

## Web

```js
web_search({ query: "TypeScript Pi coding agent extensions", numResults: 5 })
web_fetch({ url: "https://pi.dev/docs/latest/extensions" })
web_fetch({ url: "https://example.com/long", offset: 32000, limit: 8000 })
web_fetch({ cacheId: "abc123", offset: 32000, limit: 8000 })
```

`web_search` accepts `numResults`, `limit`, and `num_search_results` as
result-count spellings (1-20). If more than one is supplied, precedence is
`numResults` → `limit` → `num_search_results`; otherwise `web.search.maxResults`
is used. The fallback chain (skipping unconfigured providers) is SearXNG → Brave
→ Tavily → Exa → Jina → DuckDuckGo.

`/web` shows what the web tools actually did this session (provider, size, timing,
outcome) and `/web clear` empties it.

`web_fetch` requires exactly one of `url` or `cacheId`; supplying both or neither
is an error. It extracts readable markdown (Readability), truncates large pages, and
caches the full text for one hour. Headings, ordered and nested lists, tables, and
fenced code survive the conversion. `offset`/`limit` work on a fresh fetch as well
as on a `cacheId`, and every truncated result names the exact follow-up call.
Responses are decoded using the charset the server declares, and binary responses
are refused with a clear message instead of returned as mojibake.

JavaScript from pages is never executed. Private, loopback, link-local, CGNAT, and
cloud-metadata addresses are blocked in both IPv4 and IPv6 form, including
compressed and IPv4-mapped spellings, and the check is re-applied to every
redirect hop.

Requests connect to the exact addresses the safety check validated, so a hostile
resolver cannot return a public address to the check and a private one to the
socket (DNS rebinding). TLS still verifies the certificate against the real
hostname.

To reach a deliberately private service, list it in `web.allowedHosts`:

```json
{ "web": { "allowedHosts": ["localhost:8888", "10.0.0.5"] } }
```

A host configured through `web.search.searxngUrl` is trusted automatically, so a
self-hosted SearXNG on localhost works without extra setup. Entries with a port
apply to that port only.

## Subagents

```js
subagent({ agent: "scout", task: "Find the auth entry points" })
subagent({
  tasks: [
    { agent: "reviewer", task: "Review tests" },
    { agent: "reviewer", task: "Review error handling" }
  ]
})
subagent({
  chain: [
    { agent: "scout", task: "Map the payment flow" },
    { agent: "oracle", task: "Challenge this plan: {previous}" }
  ]
})
subagent({
  agent: "worker",
  task: "Implement the parser",
  outputSchema: {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"]
  },
  isolation: "worktree"
})
```

Builtin agents: `scout`, `reviewer`, `worker`, `oracle`. Override or add agents as markdown files in `~/.pi/agent/agents/` (and `.pi/agents/` with `agentScope: "project"` or `"both"` after trust). Frontmatter accepts `name`, `description`, `model`, and `tools` (inline `[a, b]`, `- a` block lists, or a comma-separated string).

Children run as isolated `pi --mode json --no-session` processes. They get the task
text only and do not load this package's MCP, todo, or question tools. Their
environment is stripped of `MCP_*`, `*_TOKEN`, `*_SECRET`, and third-party
`*_API_KEY` values; the model-provider credentials pi itself needs
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and the rest of pi's provider table) are
forwarded, because without them the child cannot authenticate at all.

Unknown agent names and over-budget requests are rejected before anything is
spawned, so a typo does not consume the session's spawn budget.

`outputSchema` is a TypeBox/JSON object schema. A top-level schema is the default
for every job, and a schema on a `tasks`/`chain` item overrides it. The child must
submit one validated `subagent_result`; its structured object is returned in tool
details (and serialized into `{previous}` for the next chain step).

`isolation: "worktree"` requires a clean Git source repository and runs against a
temporary detached worktree at the current `HEAD`. Single and parallel jobs get
separate worktrees; isolated steps in a chain share one so later steps see earlier
changes. The source checkout is never modified automatically. After the run, the
temporary worktree is removed and result details report changed files plus a
binary-capable patch artifact path; the patch is **not** auto-applied.

`/subagents` lists agents and running jobs; `/subagents cancel <id|all>` stops them. A FleetView panel below the editor tracks each running child with a live spinner and elapsed time.

## Todos

```js
todo({ action: "create", content: "Implement feature", phase: "build" })
todo({ action: "create", content: "Add repository tests", phase: "verify", blockedBy: [1] })
todo({ action: "update", id: 2, status: "in_progress" })
todo({ action: "block", id: 2, blocker: "Waiting for CI" })
todo({ action: "complete", id: 1 })
todo({ action: "list" })
```

Statuses are `pending`, `in_progress`, `completed`, `blocked`, and `abandoned`.
Actions are `list`, `create`, `update`, `complete`, `reopen`, `block`, `unblock`,
`abandon`, `delete`, `clear`, and `sync`. `phase` and `blocker` are optional
metadata; `blockedBy` stores dependency IDs.

`sync` atomically replaces the complete list from a `todos` snapshot. It preserves
the supplied IDs, dependencies, phases, blockers, and statuses, validates missing
references/cycles and the single-`in_progress` rule, then allocates future IDs
above the highest supplied ID. Ordinary updates retain IDs and dependencies unless
they are explicitly changed.

State is reconstructed from the current session branch, so it survives `/reload`,
compaction, and `/tree` navigation. `blockedBy` dependencies are validated for
missing ids and cycles; selecting a still-blocked item as `in_progress` returns a
warning, while selecting a second `in_progress` item atomically moves the previous
one back to `pending`. Completing an item reports what it unblocked. `/todos`
prints the list and `/todos clear` empties it, grouped by status. A panel above the
editor shows unfinished work first, with completed rows struck through.

## Ask the user

```js
ask_user_question({
  questions: [
    {
      id: "cache",
      question: "Which cache should we add?",
      options: [
        { label: "In-memory", value: "memory", description: "Fast, per-process" },
        { label: "Redis", value: "redis", description: "Shared, extra ops" },
        { label: "None", value: "none", description: "Skip caching" }
      ],
      recommended: 0,
      allowOther: true,
      multiple: false
    }
  ]
})
```

Options are presented numbered, so a selection is matched by position rather than
by re-parsing its label. `id` is echoed in result details, and an option's `value`
provides its machine-readable answer (falling back to its label). `recommended` is
a validated zero-based metadata index; Pi's current selector does not display or
preselect it. `allowOther` defaults to `true` and controls the free-text path. `multiple` is
an alias for `multiSelect`; if both are present they must agree.

With either multi-select spelling enabled, the user keeps picking until choosing
**Done**. Result details include each answer's `id`, question/header, selected
labels, option values, zero-based indices, and any custom text. The tool waits for
the answer, then the parent turn continues. It is removed from the model tool list
in non-interactive runs.

## Security

- No `eval`, no install/postinstall scripts, no shell interpolation of untrusted input (`spawn` argv arrays only).
- Downloaded web content is parsed as HTML/text, never executed.
- Network fetches validate DNS, block private ranges on every redirect hop, and
  connect only to the addresses that were validated (no DNS-rebinding window).
- Compressed responses are bounded by both a compressed and a decompressed cap,
  so a decompression bomb cannot exhaust memory.
- MCP and web operations have timeouts and response size caps. Binary MCP content
  is summarized rather than pasted into context.
- Subagents do not inherit parent transcripts or MCP secrets. Only the
  model-provider credentials pi needs to run are forwarded.
- Tool failures are raised, so pi reports them to the model as errors rather than
  as prose that merely looks like one.

## Development

```bash
npm install
npm run check     # typecheck + tests
npm test
npm run typecheck
```

## License

MIT

## Community

- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)
