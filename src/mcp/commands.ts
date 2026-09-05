import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../errors.ts";
import type { McpManager } from "./manager.ts";

export interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

const MCP_SUBCOMMANDS: Array<{ name: string; description: string }> = [
  { name: "status", description: "Show MCP server status table" },
  { name: "tools", description: "List all discovered tools across servers" },
  { name: "enable", description: "Enable a disabled MCP server" },
  { name: "disable", description: "Disable an MCP server" },
  { name: "reconnect", description: "Reconnect a specific server or all servers" },
  { name: "auth", description: "Authenticate with an OAuth MCP server" },
  { name: "auth-start", description: "Start background OAuth flow" },
  { name: "auth-complete", description: "Complete OAuth flow with redirect URL or code" },
  { name: "logout", description: "Clear stored OAuth credentials for a server" },
  { name: "disconnect", description: "Disconnect an active server or all servers" },
];

export function getMcpArgumentCompletions(
  manager: McpManager,
  argumentPrefix: string,
): AutocompleteItem[] | null {
  const trimmedLeading = argumentPrefix.trimStart();
  const spaceIndex = trimmedLeading.indexOf(" ");

  if (spaceIndex === -1) {
    const q = trimmedLeading.toLowerCase();
    const matches = MCP_SUBCOMMANDS.filter((sub) => sub.name.toLowerCase().startsWith(q));
    if (matches.length === 0) return null;
    return matches.map((sub) => ({
      value: sub.name,
      label: sub.name,
      description: sub.description,
    }));
  }

  const sub = trimmedLeading.slice(0, spaceIndex).toLowerCase();
  const serverPrefix = trimmedLeading.slice(spaceIndex + 1).trimStart().toLowerCase();

  let servers: Array<{ name: string; info: string }> = [];

  if (sub === "enable") {
    servers = manager
      .listServers()
      .filter((s) => s.disabled)
      .map((s) => ({ name: s.name, info: `${s.transport} (disabled)` }));
  } else if (sub === "disable") {
    servers = manager
      .listServers()
      .filter((s) => !s.disabled)
      .map((s) => ({ name: s.name, info: `${s.status} (${s.transport})` }));
  } else if (sub === "auth" || sub === "auth-start" || sub === "logout") {
    servers = manager.getOAuthServers().map((s) => ({ name: s.name, info: `status: ${s.status}` }));
  } else if (sub === "reconnect") {
    servers = manager
      .listServers()
      .filter((s) => !s.disabled)
      .map((s) => ({ name: s.name, info: `status: ${s.status}` }));
  } else if (sub === "disconnect") {
    servers = manager
      .listServers()
      .filter((s) => s.status === "connected")
      .map((s) => ({ name: s.name, info: "connected" }));
  } else {
    return null;
  }

  const matches = servers.filter((s) => s.name.toLowerCase().startsWith(serverPrefix));
  if (matches.length === 0) return null;

  return matches.map((s) => ({
    value: `${sub} ${s.name}`,
    label: s.name,
    description: s.info,
  }));
}

const USAGE =
  "Usage: /mcp [status|tools|enable [name]|disable [name]|reconnect [name]|auth <name> [redirectUrl]|auth-start <name>|auth-complete <name> <redirectUrl>|logout <name>|disconnect [name]]";

export function registerMcpCommands(
  pi: ExtensionAPI,
  manager: McpManager,
  onStatusChange?: (ctx: ExtensionContext) => void,
): void {
  pi.registerCommand("mcp", {
    description:
      "Show MCP server status, manage servers, or authenticate OAuth. Usage: /mcp [enable|disable|auth|reconnect]",
    getArgumentCompletions: (argumentPrefix: string) => getMcpArgumentCompletions(manager, argumentPrefix),
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase();
      try {
        switch (sub) {
          case undefined: {
            if (ctx.hasUI) {
              const actions = [
                "📊 Status — View MCP server status table",
                "🔧 Tools — List all discovered tools",
                "⚡ Reconnect — Reconnect MCP servers",
                "✅ Enable — Enable an MCP server",
                "⛔ Disable — Disable an MCP server",
                "🔑 Auth — Authenticate with an OAuth server",
                "🚪 Disconnect — Disconnect MCP servers",
              ];
              const choice = await ctx.ui.select("MCP Actions", actions);
              if (!choice) return;
              if (choice.startsWith("📊 Status")) {
                ctx.ui.notify(manager.formatStatus(), "info");
              } else if (choice.startsWith("🔧 Tools")) {
                ctx.ui.notify("Connecting to MCP servers…", "info");
                await manager.ensureAllTools();
                const tools = manager.allCachedTools();
                ctx.ui.notify(
                  tools.length === 0
                    ? "No MCP tools available. Check /mcp status."
                    : tools.map((t) => `${t.prefixedName} — ${t.description || "(no description)"}`).join("\n"),
                  "info",
                );
              } else if (choice.startsWith("⚡ Reconnect")) {
                await manager.refreshAll();
                ctx.ui.notify(`Reconnected MCP servers\n\n${manager.formatStatus()}`, "info");
              } else if (choice.startsWith("✅ Enable")) {
                const disabled = manager.listServers().filter((s) => s.disabled);
                if (disabled.length === 0) {
                  ctx.ui.notify("No disabled MCP servers found.", "info");
                  return;
                }
                const picked = await ctx.ui.select(
                  "Select MCP server to enable",
                  disabled.map((s) => `${s.name} (${s.transport})`),
                );
                if (!picked) return;
                const name = picked.split(" ")[0];
                await manager.setServerDisabled(name, false);
                ctx.ui.notify(`Enabled MCP server "${name}".`, "info");
              } else if (choice.startsWith("⛔ Disable")) {
                const enabled = manager.listServers().filter((s) => !s.disabled);
                if (enabled.length === 0) {
                  ctx.ui.notify("No enabled MCP servers found.", "info");
                  return;
                }
                const picked = await ctx.ui.select(
                  "Select MCP server to disable",
                  enabled.map((s) => `${s.name} (${s.status}, ${s.transport})`),
                );
                if (!picked) return;
                const name = picked.split(" ")[0];
                await manager.setServerDisabled(name, true);
                ctx.ui.notify(`Disabled MCP server "${name}".`, "info");
              } else if (choice.startsWith("🔑 Auth")) {
                const oauthServers = manager.getOAuthServers();
                if (oauthServers.length === 0) {
                  ctx.ui.notify("No OAuth-capable MCP servers configured.", "warning");
                  return;
                }
                const picked = await ctx.ui.select(
                  "Select MCP server to authenticate",
                  oauthServers.map((s) => `${s.name} (${s.status})`),
                );
                if (!picked) return;
                const name = picked.split(" ")[0];
                ctx.ui.notify(await manager.auth(name), "info");
              } else if (choice.startsWith("🚪 Disconnect")) {
                await manager.disconnect();
                ctx.ui.notify("Disconnected all MCP servers", "info");
              }
              return;
            }
            ctx.ui.notify(manager.formatStatus(), "info");
            return;
          }

          case "status":
            ctx.ui.notify(manager.formatStatus(), "info");
            return;

          case "tools": {
            ctx.ui.notify("Connecting to MCP servers…", "info");
            await manager.ensureAllTools();
            const tools = manager.allCachedTools();
            ctx.ui.notify(
              tools.length === 0
                ? "No MCP tools available. Check /mcp status."
                : tools.map((t) => `${t.prefixedName} — ${t.description || "(no description)"}`).join("\n"),
              "info",
            );
            return;
          }

          case "enable": {
            let name = parts[1];
            if (!name) {
              if (ctx.hasUI) {
                const disabled = manager.listServers().filter((s) => s.disabled);
                if (disabled.length === 0) {
                  ctx.ui.notify("No disabled MCP servers found.", "info");
                  return;
                }
                const choices = disabled.map((s) => `${s.name} (${s.transport})`);
                const picked = await ctx.ui.select("Select MCP server to enable", choices);
                if (!picked) return;
                name = picked.split(" ")[0];
              } else {
                ctx.ui.notify("Usage: /mcp enable <server>", "warning");
                return;
              }
            }
            await manager.setServerDisabled(name, false);
            ctx.ui.notify(`Enabled MCP server "${name}".`, "info");
            return;
          }

          case "disable": {
            let name = parts[1];
            if (!name) {
              if (ctx.hasUI) {
                const enabled = manager.listServers().filter((s) => !s.disabled);
                if (enabled.length === 0) {
                  ctx.ui.notify("No enabled MCP servers found.", "info");
                  return;
                }
                const choices = enabled.map((s) => `${s.name} (${s.status}, ${s.transport})`);
                const picked = await ctx.ui.select("Select MCP server to disable", choices);
                if (!picked) return;
                name = picked.split(" ")[0];
              } else {
                ctx.ui.notify("Usage: /mcp disable <server>", "warning");
                return;
              }
            }
            await manager.setServerDisabled(name, true);
            ctx.ui.notify(`Disabled MCP server "${name}".`, "info");
            return;
          }

          case "reconnect": {
            const name = parts[1];
            if (name) {
              await manager.connect(name, undefined, true);
              ctx.ui.notify(`Reconnected ${name}`, "info");
            } else {
              await manager.refreshAll();
              ctx.ui.notify(`Reconnected MCP servers\n\n${manager.formatStatus()}`, "info");
            }
            return;
          }

          case "auth": {
            let name = parts[1];
            if (!name) {
              if (ctx.hasUI) {
                const oauthServers = manager.getOAuthServers();
                if (oauthServers.length === 0) {
                  ctx.ui.notify("No OAuth-capable MCP servers configured.", "warning");
                  return;
                }
                const choices = oauthServers.map((s) => `${s.name} (${s.status})`);
                const picked = await ctx.ui.select("Select MCP server to authenticate", choices);
                if (!picked) return;
                name = picked.split(" ")[0];
              } else {
                ctx.ui.notify("Usage: /mcp auth <server> [redirectUrl]", "warning");
                return;
              }
            }
            ctx.ui.notify(await manager.auth(name, parts[2]), "info");
            return;
          }

          case "auth-start": {
            let name = parts[1];
            if (!name) {
              if (ctx.hasUI) {
                const oauthServers = manager.getOAuthServers();
                if (oauthServers.length === 0) {
                  ctx.ui.notify("No OAuth-capable MCP servers configured.", "warning");
                  return;
                }
                const choices = oauthServers.map((s) => `${s.name} (${s.status})`);
                const picked = await ctx.ui.select("Select MCP server for OAuth start", choices);
                if (!picked) return;
                name = picked.split(" ")[0];
              } else {
                ctx.ui.notify("Usage: /mcp auth-start <server>", "warning");
                return;
              }
            }
            const { message } = await manager.authStart(name);
            ctx.ui.notify(message, "info");
            return;
          }

          case "auth-complete": {
            const name = parts[1];
            const redirectUrl = parts[2];
            if (!name || !redirectUrl) {
              ctx.ui.notify("Usage: /mcp auth-complete <server> <redirectUrl>", "warning");
              return;
            }
            ctx.ui.notify(await manager.authComplete(name, { redirectUrl }), "info");
            return;
          }

          case "logout": {
            let name = parts[1];
            if (!name) {
              if (ctx.hasUI) {
                const oauthServers = manager.getOAuthServers();
                if (oauthServers.length === 0) {
                  ctx.ui.notify("No OAuth-capable MCP servers configured.", "warning");
                  return;
                }
                const choices = oauthServers.map((s) => `${s.name} (${s.status})`);
                const picked = await ctx.ui.select("Select MCP server to logout", choices);
                if (!picked) return;
                name = picked.split(" ")[0];
              } else {
                ctx.ui.notify("Usage: /mcp logout <server>", "warning");
                return;
              }
            }
            ctx.ui.notify(await manager.logout(name), "info");
            return;
          }

          case "disconnect":
            await manager.disconnect(parts[1]);
            ctx.ui.notify(parts[1] ? `Disconnected ${parts[1]}` : "Disconnected all MCP servers", "info");
            return;

          default:
            ctx.ui.notify(USAGE, "warning");
        }
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      } finally {
        onStatusChange?.(ctx);
      }
    },
  });

  pi.registerCommand("mcp-auth", {
    description: "Authenticate with an OAuth MCP server. Usage: /mcp-auth [name]",
    getArgumentCompletions: (argumentPrefix: string) => {
      const q = argumentPrefix.trim().toLowerCase();
      const servers = manager.getOAuthServers();
      const matches = servers.filter((s) => s.name.toLowerCase().startsWith(q));
      if (matches.length === 0) return null;
      return matches.map((s) => ({
        value: s.name,
        label: s.name,
        description: `status: ${s.status}`,
      }));
    },
    handler: async (args, ctx) => {
      const name = args.trim().split(/\s+/)[0];
      try {
        if (!name) {
          if (ctx.hasUI) {
            const oauthServers = manager.getOAuthServers();
            if (oauthServers.length === 0) {
              ctx.ui.notify("No OAuth-capable MCP servers configured.", "warning");
              return;
            }
            const choices = oauthServers.map((s) => `${s.name} (${s.status})`);
            const picked = await ctx.ui.select("Select MCP server to authenticate", choices);
            if (!picked) return;
            const chosen = picked.split(" ")[0];
            ctx.ui.notify(await manager.auth(chosen), "info");
            return;
          }
          ctx.ui.notify("Usage: /mcp-auth <server>", "warning");
          return;
        }
        ctx.ui.notify(await manager.auth(name), "info");
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      } finally {
        onStatusChange?.(ctx);
      }
    },
  });
}

