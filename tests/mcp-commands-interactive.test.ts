import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMcpServers, saveProjectMcpOverride } from "../src/mcp/config.ts";
import { getMcpArgumentCompletions, registerMcpCommands } from "../src/mcp/commands.ts";
import { McpManager } from "../src/mcp/manager.ts";
import { registerMcpTool } from "../src/mcp/proxy-tool.ts";
import { resolveConfig } from "../src/config.ts";

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-essentials-mcp-cmd-"));
}

describe("MCP commands autocomplete, dialogs, and enable/disable", () => {
  let tmpDir: string;
  let prevAgentDir: string | undefined;

  beforeEach(() => {
    tmpDir = createTmpDir();
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(tmpDir, "agent");
    fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  });

  afterEach(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function setupServers(): McpManager {
    // Create .mcp.json in cwd with one stdio and one http server
    const mcpJson = {
      mcpServers: {
        github: {
          url: "https://api.github.com/mcp",
          auth: "oauth",
        },
        local_tool: {
          command: "node",
          args: ["-e", "console.log(1)"],
        },
        disabled_tool: {
          command: "node",
          args: ["-e", "console.log(2)"],
          disabled: true,
        },
      },
    };
    fs.writeFileSync(path.join(tmpDir, ".mcp.json"), JSON.stringify(mcpJson, null, 2), "utf8");
    return new McpManager(tmpDir, resolveConfig({}));
  }

  it("provides subcommand autocompletions when no space is entered", () => {
    const manager = setupServers();
    const all = getMcpArgumentCompletions(manager, "");
    expect(all).not.toBeNull();
    const names = all!.map((item) => item.value);
    expect(names).toContain("status");
    expect(names).toContain("tools");
    expect(names).toContain("enable");
    expect(names).toContain("disable");
    expect(names).toContain("auth");
    expect(names).toContain("reconnect");

    const filtered = getMcpArgumentCompletions(manager, "en");
    expect(filtered).toEqual([
      { value: "enable", label: "enable", description: "Enable a disabled MCP server" },
    ]);
  });

  it("provides contextual server completions after subcommands", () => {
    const manager = setupServers();

    // After "enable ", should suggest disabled servers
    const enableCompletions = getMcpArgumentCompletions(manager, "enable ");
    expect(enableCompletions).not.toBeNull();
    expect(enableCompletions!.map((c) => c.value)).toEqual(["enable disabled_tool"]);

    // After "disable ", should suggest enabled servers
    const disableCompletions = getMcpArgumentCompletions(manager, "disable ");
    expect(disableCompletions).not.toBeNull();
    const disabledNames = disableCompletions!.map((c) => c.value);
    expect(disabledNames).toContain("disable github");
    expect(disabledNames).toContain("disable local_tool");
    expect(disabledNames).not.toContain("disable disabled_tool");

    // After "auth ", should suggest OAuth servers
    const authCompletions = getMcpArgumentCompletions(manager, "auth ");
    expect(authCompletions).not.toBeNull();
    expect(authCompletions!.map((c) => c.value)).toEqual(["auth github"]);
  });

  it("persists project overrides into .pi/mcp.json", () => {
    saveProjectMcpOverride(tmpDir, "github", { disabled: true });
    const targetFile = path.join(tmpDir, ".pi", "mcp.json");
    expect(fs.existsSync(targetFile)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(targetFile, "utf8"));
    expect(parsed.mcpServers?.github?.disabled).toBe(true);

    // Save another override and verify merging
    saveProjectMcpOverride(tmpDir, "local_tool", { disabled: true });
    const parsed2 = JSON.parse(fs.readFileSync(targetFile, "utf8"));
    expect(parsed2.mcpServers?.github?.disabled).toBe(true);
    expect(parsed2.mcpServers?.local_tool?.disabled).toBe(true);
  });

  it("merges partial overrides in loadMcpServers without requiring command or url", () => {
    // Base file has definition
    const base = {
      mcpServers: {
        serverA: { command: "node", args: ["server.js"] },
      },
    };
    fs.writeFileSync(path.join(tmpDir, ".mcp.json"), JSON.stringify(base), "utf8");

    // Project override has only disabled: true
    saveProjectMcpOverride(tmpDir, "serverA", { disabled: true });

    const result = loadMcpServers(tmpDir);
    expect(result.warnings).toHaveLength(0);
    const serverA = result.servers.find((s) => s.name === "serverA");
    expect(serverA).toBeDefined();
    expect(serverA?.definition.command).toBe("node");
    expect(serverA?.definition.disabled).toBe(true);
  });

  it("enables and disables servers dynamically and persists", async () => {
    const manager = setupServers();
    expect(manager.listServers().find((s) => s.name === "disabled_tool")?.disabled).toBe(true);

    await manager.setServerDisabled("disabled_tool", false);
    expect(manager.listServers().find((s) => s.name === "disabled_tool")?.disabled).toBe(false);

    // Verify .pi/mcp.json recorded the change
    const overrideFile = path.join(tmpDir, ".pi", "mcp.json");
    expect(fs.existsSync(overrideFile)).toBe(true);
    const content = JSON.parse(fs.readFileSync(overrideFile, "utf8"));
    expect(content.mcpServers?.disabled_tool?.disabled).toBe(false);

    // Disable github
    await manager.setServerDisabled("github", true);
    expect(manager.listServers().find((s) => s.name === "github")?.disabled).toBe(true);
  });

  it("handles /mcp enable and /mcp disable with arguments", async () => {
    const manager = setupServers();
    const registeredCommands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const mockPi = {
      registerCommand: (name: string, cmd: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        registeredCommands.set(name, cmd);
      },
    };
    registerMcpCommands(mockPi as never, manager);

    const notify = vi.fn();
    const ctx = { hasUI: false, ui: { notify } };

    const mcpCmd = registeredCommands.get("mcp")!;
    await mcpCmd.handler("enable disabled_tool", ctx);
    expect(notify).toHaveBeenCalledWith('Enabled MCP server "disabled_tool".', "info");
    expect(manager.listServers().find((s) => s.name === "disabled_tool")?.disabled).toBe(false);

    await mcpCmd.handler("disable local_tool", ctx);
    expect(notify).toHaveBeenCalledWith('Disabled MCP server "local_tool".', "info");
    expect(manager.listServers().find((s) => s.name === "local_tool")?.disabled).toBe(true);
  });

  it("opens interactive select dialog when /mcp enable or disable is run without args in TUI", async () => {
    const manager = setupServers();
    const registeredCommands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const mockPi = {
      registerCommand: (name: string, cmd: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        registeredCommands.set(name, cmd);
      },
    };
    registerMcpCommands(mockPi as never, manager);

    const notify = vi.fn();
    const select = vi.fn().mockResolvedValue("disabled_tool (stdio)");
    const ctx = { hasUI: true, ui: { notify, select } };

    const mcpCmd = registeredCommands.get("mcp")!;
    await mcpCmd.handler("enable", ctx);
    expect(select).toHaveBeenCalledWith("Select MCP server to enable", ["disabled_tool (stdio)"]);
    expect(notify).toHaveBeenCalledWith('Enabled MCP server "disabled_tool".', "info");
    expect(manager.listServers().find((s) => s.name === "disabled_tool")?.disabled).toBe(false);
  });

  it("handles /mcp-auth command with autocomplete and interactive dialog", async () => {
    const manager = setupServers();
    const registeredCommands = new Map<
      string,
      {
        handler: (args: string, ctx: unknown) => Promise<void>;
        getArgumentCompletions?: (prefix: string) => unknown;
      }
    >();
    const mockPi = {
      registerCommand: (name: string, cmd: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        registeredCommands.set(name, cmd);
      },
    };
    registerMcpCommands(mockPi as never, manager);

    const mcpAuthCmd = registeredCommands.get("mcp-auth")!;
    expect(mcpAuthCmd).toBeDefined();

    // Verify autocompletion for /mcp-auth
    const completions = mcpAuthCmd.getArgumentCompletions?.("git") as Array<{ value: string }>;
    expect(completions).toEqual([{ value: "github", label: "github", description: "status: idle" }]);

    // Verify interactive selection when run without argument in TUI
    const notify = vi.fn();
    const select = vi.fn().mockResolvedValue("github (idle)");
    const ctx = { hasUI: true, ui: { notify, select } };

    vi.spyOn(manager, "auth").mockResolvedValue("Authenticated with github.");
    await mcpAuthCmd.handler("", ctx);
    expect(select).toHaveBeenCalledWith("Select MCP server to authenticate", ["github (idle)"]);
    expect(notify).toHaveBeenCalledWith("Authenticated with github.", "info");
  });

  it("supports enable and disable actions in mcp proxy tool", async () => {
    const manager = setupServers();
    let registeredToolDef: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    const mockPi = {
      registerTool: (tool: { execute: (...args: unknown[]) => Promise<unknown> }) => {
        registeredToolDef = tool;
      },
    };
    registerMcpTool(mockPi as never, manager);
    expect(registeredToolDef).toBeDefined();

    // Disable a server via tool call
    const res1 = (await registeredToolDef!.execute("call-1", { action: "disable", server: "local_tool" })) as {
      content: Array<{ text: string }>;
    };
    expect(res1.content[0].text).toBe('Disabled MCP server "local_tool".');
    expect(manager.listServers().find((s) => s.name === "local_tool")?.disabled).toBe(true);

    // Re-enable
    const res2 = (await registeredToolDef!.execute("call-2", { action: "enable", server: "local_tool" })) as {
      content: Array<{ text: string }>;
    };
    expect(res2.content[0].text).toBe('Enabled MCP server "local_tool".');
    expect(manager.listServers().find((s) => s.name === "local_tool")?.disabled).toBe(false);
  });
});
