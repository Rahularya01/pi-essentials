import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { buildPaneCommand, openInspectorPane, runHerdr, type SpawnLike } from "../src/subagents/herdr.ts";

/** Minimal fake `spawn` that lets a test script the child's stdout/stderr/exit. */
function fakeSpawn(
  script: (call: { args: string[] }) => { stdout?: string; stderr?: string; exitCode?: number; spawnError?: Error },
): { spawn: SpawnLike; calls: string[][] } {
  const calls: string[][] = [];
  const spawn = ((..._callArgs: unknown[]) => {
    const args = (_callArgs[1] as readonly string[] | undefined) ?? [];
    calls.push([...args]);
    const fakeStream = () => Object.assign(new EventEmitter(), { setEncoding: () => undefined });
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = fakeStream();
    child.stderr = fakeStream();
    const result = script({ args: [...args] });
    queueMicrotask(() => {
      if (result.spawnError) {
        child.emit("error", result.spawnError);
        return;
      }
      if (result.stdout) child.stdout.emit("data", result.stdout);
      if (result.stderr) child.stderr.emit("data", result.stderr);
      child.emit("close", result.exitCode ?? 0);
    });
    return child as never;
  }) as unknown as SpawnLike;
  return { spawn, calls };
}

describe("herdr client", () => {
  it("quotes paths safely for posix and windows shells", () => {
    const posix = buildPaneCommand("/usr/bin/node", ["/tmp/pi essentials/events.jsonl"], "linux");
    expect(posix).toBe("'/usr/bin/node' '/tmp/pi essentials/events.jsonl'");

    const withQuote = buildPaneCommand("node", ["it's a path"], "darwin");
    expect(withQuote).toBe(`'node' 'it'\\''s a path'`);

    const win = buildPaneCommand("node.exe", ['a "quoted" arg'], "win32");
    expect(win).toBe('"node.exe" "a \\"quoted\\" arg"');
  });

  it("unwraps a successful herdr JSON reply", async () => {
    const { spawn, calls } = fakeSpawn(() => ({ stdout: JSON.stringify({ result: { pane_id: "p1" } }) }));
    const result = await runHerdr(["pane", "get", "p1"], { spawnImpl: spawn });
    expect(result).toEqual({ ok: true, data: { pane_id: "p1" } });
    expect(calls).toEqual([["pane", "get", "p1"]]);
  });

  it("reports a clear error when herdr is not installed", async () => {
    const { spawn } = fakeSpawn(() => ({ spawnError: Object.assign(new Error("nope"), { code: "ENOENT" }) }));
    const result = await runHerdr(["--version"], { spawnImpl: spawn });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("HERDR_UNAVAILABLE");
      expect(result.error.message).toContain("not installed");
    }
  });

  it("surfaces stderr when herdr exits non-zero", async () => {
    const { spawn } = fakeSpawn(() => ({ stderr: "pane not found\n", exitCode: 1 }));
    const result = await runHerdr(["pane", "get", "gone"], { spawnImpl: spawn });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("pane not found");
  });

  it("opens a pane end to end: version probe, split, run", async () => {
    const { spawn, calls } = fakeSpawn(({ args }) => {
      if (args[0] === "--version") return { stdout: "0.9.0" };
      if (args[0] === "pane" && args[1] === "split") return { stdout: JSON.stringify({ result: { pane_id: "p42" } }) };
      if (args[0] === "pane" && args[1] === "run") return { stdout: "" };
      return { stdout: "" };
    });
    const result = await openInspectorPane({ cwd: "/repo", command: "'node' '/tmp/script.mjs'", spawnImpl: spawn });
    expect(result).toEqual({ ok: true, paneId: "p42" });
    expect(calls[1]).toEqual(["pane", "split", "--current", "--direction", "right", "--cwd", "/repo", "--no-focus"]);
    expect(calls[2]).toEqual(["pane", "run", "p42", "'node' '/tmp/script.mjs'"]);
  });

  it("closes the pane it just opened when starting the viewer fails", async () => {
    const { spawn, calls } = fakeSpawn(({ args }) => {
      if (args[0] === "--version") return { stdout: "0.9.0" };
      if (args[0] === "pane" && args[1] === "split") return { stdout: JSON.stringify({ result: { pane_id: "p7" } }) };
      if (args[0] === "pane" && args[1] === "run") return { stderr: "boom", exitCode: 1 };
      return { stdout: "" };
    });
    const result = await openInspectorPane({ cwd: "/repo", command: "node script.mjs", spawnImpl: spawn });
    expect(result.ok).toBe(false);
    expect(calls.at(-1)).toEqual(["pane", "close", "p7"]);
  });

  it("fails cleanly when herdr is unavailable at the version probe", async () => {
    const { spawn } = fakeSpawn(() => ({ spawnError: Object.assign(new Error("nope"), { code: "ENOENT" }) }));
    const result = await openInspectorPane({ cwd: "/repo", command: "node script.mjs", spawnImpl: spawn });
    expect(result).toEqual({ ok: false, message: expect.stringContaining("Herdr is not available") });
  });
});
