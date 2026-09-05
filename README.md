# pi-essentials

[![npm version](https://img.shields.io/npm/v/@rahularya01/pi-essentials?logo=npm)](https://www.npmjs.com/package/@rahularya01/pi-essentials)
[![license](https://img.shields.io/npm/l/@rahularya01/pi-essentials)](LICENSE)
[![CI](https://github.com/Rahularya01/pi-essentials/actions/workflows/ci.yml/badge.svg)](https://github.com/Rahularya01/pi-essentials/actions/workflows/ci.yml)
[![Sponsor](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?logo=github)](https://github.com/sponsors/Rahularya01)

**pi-essentials** (currently in beta) is a battery-included extensions bundle for the [Pi Coding Agent](https://pi.dev) that adds **Model Context Protocol (MCP)**, **Web access (search & fetch)**, **Subagents**, **Todos**, and **Structured user questions** in a single, lightweight plugin.

Pi itself ships without these capabilities. `pi-essentials` registers them with a single shared configuration, zero external runtime bloat, and a security-first architecture. It does **not** wrap `pi-mcp-adapter`, `pi-web-access`, or juicesharp packages — it follows their proven patterns (proxy MCP tool, Readability extraction, isolated child sessions, session-branch todos) with a smaller, original surface.

> Using Google Antigravity / Gemini models with Pi? Pair this with the companion provider extension [`pi-antigravity`](https://github.com/Rahularya01/pi-antigravity).

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Commands](#commands)
- [MCP (Model Context Protocol)](#mcp-model-context-protocol)
- [Web access](#web-access)
- [Subagents](#subagents)
- [Todos](#todos)
- [Ask the user](#ask-the-user)
- [Terminal UI and panels](#terminal-ui-and-panels)
- [Configuration](#configuration)
- [Security](#security)
- [Development](#development)
- [Support the project](#support-the-project)
- [License](#license)

## Requirements

- Node.js **22 or later** (uses native TypeScript type-stripping, zero build step required)
- Pi Coding Agent (`@earendil-works/pi-coding-agent`) version **0.80.0 or later**

## Install

Install from npm:

```bash
pi install npm:@rahularya01/pi-essentials
```

Or install directly from GitHub:

```bash
pi install git:github.com/Rahularya01/pi-essentials
```

Or from a local checkout:

```bash
pi install /absolute/path/to/pi-essentials
```

Or add it to your global `~/.pi/agent/settings.json` or project `.pi/settings.json`:

```json
{
  "packages": ["npm:@rahularya01/pi-essentials"]
}
```

Restart Pi (or run `/reload`) after installation. To update the package later, use `pi update npm:@rahularya01/pi-essentials`.

## Quick start

1. Install the extension: `pi install npm:@rahularya01/pi-essentials`.
2. Configure any MCP servers you need in `.mcp.json` or `~/.config/mcp/mcp.json`.
3. Start Pi. Type `/mcp` for an interactive server management hub, or `/todos` to view active tasks.
4. Prompt Pi naturally — it will discover MCP tools on demand, perform web research, spawn subagents, and keep track of todos automatically.

## Commands

| Command | Description |
|---|---|
| `/mcp` | Interactive server management hub (or shows status table in non-interactive mode) |
| `/mcp tools` | Connect and list all discovered tools across configured MCP servers |
| `/mcp enable [server]` | Enable an MCP server (opens an interactive selector if omitted in TUI) |
| `/mcp disable [server]` | Disable an MCP server (opens an interactive selector if omitted in TUI) |
| `/mcp auth [server] [url]` | Authenticate an OAuth MCP server (interactive selector if omitted in TUI) |
| `/mcp-auth [server]` | Dedicated shortcut to authenticate with an OAuth MCP server |
| `/mcp auth-start <server>` | Initiate OAuth and output the authorization URL immediately |
| `/mcp auth-complete <server> <url>` | Complete an OAuth flow with pasted redirect URL or code |
| `/mcp reconnect [server]` | Reconnect a specific server or all active servers |
| `/mcp logout <server>` | Clear stored OAuth credentials for a server |
| `/mcp disconnect [server]` | Disconnect an active server or all servers |
| `/todos` | Print current session todos grouped by status |
| `/todos clear` | Clear todos in the current session branch |
| `/subagents` | Open the interactive two-column fleet inspector |
| `/subagents pane [id]` | Open a running child subagent in an external Herdr pane |
| `/subagents cancel <id\|all>` | Cancel running subagent tasks |
| `/web` | Show recent web search and fetch activity (timing, size, outcome) |
| `/web clear` | Clear web activity log |

All `/mcp` subcommands and server names support **Tab autosuggestions**.

## MCP (Model Context Protocol)

Reads standard MCP configuration files, with project-level files overriding user-level files:

1. `~/.config/mcp/mcp.json`
2. `~/.agents/mcp.json`
3. `~/.agents/mcp/mcp.json`
4. `~/.pi/agent/mcp.json`
5. `.mcp.json`
6. `.pi/mcp.json`

Supports stdio (`command`/`args`) and HTTP (`url`), with Streamable HTTP and automatic SSE fallback. Servers are **lazy** by default: they start on first use and automatically disconnect after an idle timeout. One proxy tool keeps MCP schemas out of the model's context until needed.

```js
mcp({ action: "search", query: "screenshot" })
mcp({ action: "describe", tool: "chrome_devtools_take_screenshot" })
mcp({ action: "call", tool: "chrome_devtools_take_screenshot", args: { format: "png" } })
mcp({ action: "status" })
mcp({ action: "enable", server: "linear" })
mcp({ action: "disable", server: "linear" })
mcp({ action: "auth", server: "linear" })
mcp({ action: "auth-start", server: "linear" })
mcp({ action: "auth-complete", server: "linear", redirectUrl: "http://127.0.0.1:5173/callback?code=...&state=..." })
mcp({ action: "auth-complete", server: "linear", code: "..." })
mcp({ action: "logout", server: "linear" })
```

Servers can share defaults through a `settings` block in the same file:

```json
{ "settings": { "requestTimeoutMs": 30000, "idleTimeout": 10 }, "mcpServers": { } }
```

- **Autosuggestions & Dialogs:** Typing `/mcp <Tab>` suggests subcommands; `/mcp enable <Tab>` or `/mcp auth <Tab>` suggests servers. Running `/mcp enable` or `/mcp disable` without arguments in the TUI opens an interactive selector (`ctx.ui.select`).
- **Persistent Overrides:** Toggling server status via `/mcp enable` or `/mcp disable` persists the setting in `.pi/mcp.json` without modifying the global config file.
- **OAuth Security:** Uses PKCE and a temporary loopback callback. Tokens prefer the OS credential store (macOS Keychain, Windows Credential Manager, Linux Secret Service) with fallback to a strict mode `0600` file (`~/.pi/agent/pi-essentials/mcp-oauth.json`).

Example server file: [`examples/mcp.json`](examples/mcp.json).

## Web access

```js
web_search({ query: "TypeScript Pi coding agent extensions", numResults: 5 })
web_fetch({ url: "https://pi.dev/docs/latest/extensions" })
web_fetch({ url: "https://example.com/long", offset: 32000, limit: 8000 })
web_fetch({ cacheId: "abc123", offset: 32000, limit: 8000 })
```

- **`web_search`**: Supports query aliases (`numResults`, `limit`, `num_search_results`). Fallback chain across unconfigured providers: SearXNG → Brave → Tavily → Exa → Jina → DuckDuckGo.
- **`web_fetch`**: Requires either `url` or `cacheId`. Extracts clean markdown using Mozilla Readability, truncates large pages gracefully, and caches full text for one hour.
- **SSRF Hardened**: Never executes page JavaScript. Blocks private, loopback, link-local, CGNAT, and cloud-metadata addresses on every redirect hop, with DNS-pinning to prevent rebinding attacks. Trust private services explicitly via `web.allowedHosts`.

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

- **Built-in Agents**: `scout`, `reviewer`, `worker`, `oracle`. Custom agents can be added as markdown files in `~/.pi/agent/agents/` or `.pi/agents/`.
- **Isolated Sessions**: Children run as separate `pi --mode json --no-session` child processes with sanitized environments (`MCP_*` and API secrets stripped; model credentials forwarded).
- **Worktree Isolation**: `isolation: "worktree"` runs work against a temporary detached Git worktree at `HEAD`, returning changed files and a clean patch artifact without modifying your working tree.
- **Live Fleet Inspector**: Press `↓` or `←` with the editor empty to expand the fleet roster, or run `/subagents` to open a two-column interactive live transcript inspector. Press `h` (or `/subagents pane [id]`) to open the child in an external [Herdr](https://github.com/herdrdev/herdr) pane.

## Todos

```js
todo({ action: "create", content: "Implement feature", phase: "build" })
todo({ action: "create", content: "Add repository tests", phase: "verify", blockedBy: [1] })
todo({ action: "update", id: 2, status: "in_progress" })
todo({ action: "block", id: 2, blocker: "Waiting for CI" })
todo({ action: "complete", id: 1 })
todo({ action: "list" })
```

- **Status Workflow**: `pending`, `in_progress`, `completed`, `blocked`, `abandoned`.
- **Session-Branch Persistence**: State is tied to the active session tree branch, surviving `/reload`, compaction, and `/tree` navigation.
- **Dependency Tracking**: `blockedBy` enforces valid DAG relationships, rejecting cycles and warning when selecting a blocked task. Completing an item automatically announces unblocked tasks.
- **Interactive Panel**: Displays an unobtrusive checklist widget right above the editor.

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

- Prompts the user with an interactive modal in the terminal when a real human decision is required.
- Supports single-choice, multi-select, and custom write-in answers.
- Erased automatically in non-interactive/headless runs.

## Terminal UI and panels

Three contextual panels wrap around the editor, collapsing to a single line when idle:

| Panel | Placement | Shortcut | Purpose |
|---|---|---|---|
| Todos | Above editor | `ctrl+shift+t` | Live progress bar and task checklist |
| Subagent fleet | Below editor | `ctrl+shift+a` | Active child runs, token counts, and costs |
| Web activity | Below editor | `ctrl+shift+w` | Search queries, HTTP status, and fetch sizes |
| Tool output expand | Tool card | `ctrl+o` | Expand compact tool result into full detail |

```
── Todos ───────────────────────────── ▪▪▪▪▫▫▫▫▫▫ 2/5
  ▶ #3 Wire the activity panel
  ○ #4 Update the README · needs #3
  ✓ #1 R̶e̶a̶d̶ ̶t̶h̶e̶ ̶d̶o̶c̶s̶
  +1 more (1 completed)

  2 running agents · 5/16 spawned · ↓/← to inspect

── Web activity ───────────────────────────── 3 recent
  FETCH  blog.example.com/gone      HTTP 404       260ms ✗
  FETCH  nodejs.org/api/stream.html 194.8k chars   812ms ✓
  SEARCH "typescript streams"       5 hits  2.1s ✓
```

A live footer widget tracks MCP connection status: `⚡ mcp 2/3 · 1 need auth`.

## Configuration

Create `~/.pi/agent/pi-essentials.json`, and optionally override it with `.pi/pi-essentials.json` per project. Later files win.

```json
{
  "mcp": true,
  "web": {
    "enabled": true,
    "search": { "provider": "auto", "braveApiKey": "BSA_..." }
  },
  "subagents": { "enabled": true, "maxConcurrency": 4, "spawnBudget": 16 },
  "todos": true,
  "questions": true
}
```

| Option | Default | Meaning |
|---|---|---|
| `mcp.requestTimeoutMs` | `30000` | Per-request MCP timeout in milliseconds |
| `mcp.idleTimeoutMs` | `600000` | Disconnect an idle MCP server after this duration (10 min) |
| `web.search.provider` | `"auto"` | Force a search provider or use the fallback chain |
| `web.search.timeoutMs` | `15000` | Per-request search timeout |
| `web.search.maxResults` | `5` | Default number of search results returned (1-20) |
| `web.fetch.timeoutMs` | `15000` | Per-request fetch timeout |
| `web.fetch.maxBytes` | `2097152` | Download cap before page download is cut short (2 MB) |
| `web.fetch.maxChars` | `32000` | Maximum characters returned to the model per call |
| `web.fetch.jinaFallback` | `true` | Retry failed page fetches via `r.jina.ai` |
| `web.allowedHosts` | `[]` | Private hosts to deliberately trust, as `host` or `host:port` |
| `subagents.maxConcurrency` | `4` | Maximum child subagents executing simultaneously |
| `subagents.maxParallel` | `8` | Maximum tasks allowed in a single parallel call |
| `subagents.maxOutputBytes` | `51200` | UTF-8 byte cap on returned subagent answers (50 KB) |
| `subagents.spawnBudget` | `16` | Total children allowed per session |
| `subagents.allowNested` | `false` | Allow children to spawn their own subagents |
| `subagents.herdr` | `true` | Allow opening a child in an external Herdr pane |

Environment variables for search backends: `BRAVE_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`, `JINA_API_KEY`, and `SEARXNG_URL`.

See [`examples/pi-essentials.json`](examples/pi-essentials.json) and [`examples/pi-settings.json`](examples/pi-settings.json).

## Security

- **Safe Execution**: No `eval`, no install/postinstall scripts, no shell interpolation of untrusted input (`spawn` argv arrays only).
- **Web Safety**: HTML/text parsing only; JavaScript is never executed. Strict DNS resolution checks with IP pinning prevent DNS rebinding and SSRF into private networks.
- **Decompression Protection**: Bounded by both compressed and decompressed size limits to prevent decompression bombs.
- **Subagent Sandboxing**: Children run with clean environments stripped of MCP secrets and third-party tokens. Only necessary provider credentials are forwarded.
- **Zero Silent Failures**: Tool errors throw explicitly so Pi registers them as genuine errors rather than misleading assistant text.

## Development

```bash
npm install
npm run check     # typecheck + test suite
npm test
npm run typecheck
```

See [AGENTS.md](AGENTS.md) for architectural invariants and development rules.

## Support the project

If `pi-essentials` is useful to you, consider [sponsoring the project on GitHub](https://github.com/sponsors/Rahularya01).

## License

[MIT](LICENSE)

## Community

- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)
