# pi-essentials

[![CI](https://github.com/Rahularya01/pi-essentials/actions/workflows/ci.yml/badge.svg)](https://github.com/Rahularya01/pi-essentials/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Pi Coding Agent package that combines MCP, web access, subagents, todos, and structured user questions in one plugin.

Pi itself ships without these capabilities. `pi-essentials` registers them as a single extension with a shared config, shared limits, and independent modules. It does **not** wrap `pi-mcp-adapter`, `pi-web-access`, `pi-subagents`, or the juicesharp packages — it follows their proven patterns (proxy MCP tool, readability extraction, isolated child sessions, session-branch todos) with a smaller, security-first surface.

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

API keys may also come from `BRAVE_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`, `JINA_API_KEY`, and `SEARXNG_URL`.

See [`examples/pi-essentials.json`](examples/pi-essentials.json) and [`examples/pi-settings.json`](examples/pi-settings.json).

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

Commands: `/mcp`, `/mcp reconnect [name]`, `/mcp auth <name>`.

OAuth uses PKCE and a local loopback callback. Tokens are stored at `~/.pi/agent/pi-essentials/mcp-oauth.json` (mode `0600`) keyed by `{serverName, url}`. Bearer tokens and header env interpolation (`${VAR}`, `$env:VAR`) are supported. Command-substitution secrets (`!cmd`) are not.

Example server file: [`examples/mcp.json`](examples/mcp.json).

## Web

```js
web_search({ query: "TypeScript Pi coding agent extensions" })
web_fetch({ url: "https://pi.dev/docs/latest/extensions" })
web_fetch({ cacheId: "abc123", offset: 32000, limit: 8000 })
```

`web_search` fallback chain (skips unconfigured providers): SearXNG → Brave → Tavily → Exa → Jina → DuckDuckGo.

`web_fetch` extracts readable markdown (Readability), truncates large pages, and caches the full text for one hour. JavaScript from pages is never executed. Private/localhost/link-local/metadata addresses are blocked.

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
```

Builtin agents: `scout`, `reviewer`, `worker`, `oracle`. Override or add agents as markdown files in `~/.pi/agent/agents/` (and `.pi/agents/` with `agentScope: "project"` or `"both"` after trust).

Children run as isolated `pi --mode json -p --no-session` processes. They get the task text only, a sanitized environment (no `MCP_*` / `*_API_KEY` / `*_TOKEN` / `*_SECRET`), and do not load this package's MCP, todo, or question tools. `/subagents` lists agents and running jobs.

## Todos

```js
todo({ action: "create", content: "Add repository tests" })
todo({ action: "update", id: 1, status: "in_progress" })
todo({ action: "complete", id: 1 })
todo({ action: "list" })
```

State is reconstructed from the current session branch, so it survives `/reload` and compaction. `/todos` prints the list. A compact widget appears above the editor in the TUI.

## Ask the user

```js
ask_user_question({
  questions: [
    {
      question: "Which cache should we add?",
      options: [
        { label: "In-memory", description: "Fast, per-process" },
        { label: "Redis", description: "Shared, extra ops" },
        { label: "None", description: "Skip caching" }
      ]
    }
  ]
})
```

The tool waits for the answer, then the parent turn continues. It is removed from the model tool list in non-interactive runs.

## Security

- No `eval`, no install/postinstall scripts, no shell interpolation of untrusted input (`spawn` argv arrays only).
- Downloaded web content is parsed as HTML/text, never executed.
- Network fetches validate DNS and block private ranges, including redirects.
- MCP and web operations have timeouts and response size caps.
- Subagents do not inherit parent transcripts or MCP secrets.

## Development

```bash
npm install
npm test
npm run typecheck
```

## License

MIT

## Community

- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)
