# Contributing to pi-essentials

Thanks for contributing. This package is a Pi Coding Agent extension: MCP, web access, subagents, todos, and ask-user questions.

## Development

Requires Node.js 22+.

```bash
npm install
npm test
npm run typecheck
```

Load a local checkout in Pi:

```bash
pi install /absolute/path/to/pi-essentials
```

Then restart Pi or run `/reload`.

## Guidelines

- Keep modules independent. Shared code belongs in `src/config.ts`, `src/errors.ts`, and `src/security/`.
- Do not add `eval`, install/postinstall scripts, or shell interpolation of untrusted input.
- Justify any new runtime dependency in the PR.
- Add or update tests for behavior changes.
- Keep tool errors actionable. Do not leak secrets, headers, or environment values.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make a focused change.
3. Run `npm test` and `npm run typecheck`.
4. Open a PR against `main` with a short summary of why the change is needed.

By contributing, you agree that your contributions are licensed under the MIT License.
