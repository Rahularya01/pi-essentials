# Security Policy

## Supported versions

The current `main` branch and the latest published npm version receive security fixes.

## Reporting a vulnerability

Do not open a public issue for security reports.

Please use [GitHub Security Advisories](https://github.com/Rahularya01/pi-essentials/security/advisories/new) to report:

- Secret leakage (tokens, OAuth storage, environment variables)
- SSRF bypasses in `web_fetch` / `web_search`
- Unsafe subprocess execution or shell interpolation
- Path traversal or cache-directory permission issues

Include steps to reproduce, impact, and any suggested fix. You should receive an acknowledgement within 7 days.

## Scope notes

This plugin runs inside Pi with the user's full local permissions. Reports about Pi itself should go to the [Pi project](https://github.com/earendil-works/pi). MCP servers the user configures are outside this package's trust boundary; still report adapter bugs that mishandle their output or credentials.
