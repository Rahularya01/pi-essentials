import { spawn } from "node:child_process";

export type HerdrErrorCode = "HERDR_UNAVAILABLE" | "INVALID_RESPONSE" | "TIMEOUT";

export type HerdrResult<T> = { ok: true; data: T } | { ok: false; error: { code: HerdrErrorCode; message: string } };

export type SpawnLike = typeof spawn;

const DEFAULT_TIMEOUT_MS = 15_000;

function herdrBin(): string {
  return process.env.HERDR_BIN?.trim() || "herdr";
}

function fail(code: HerdrErrorCode, message: string): HerdrResult<never> {
  return { ok: false, error: { code, message } };
}

/** Herdr replies with `{ result: ... }` on success or a bare object on some commands; tolerate both. */
function unwrap(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "result" in (parsed as Record<string, unknown>)) {
      return (parsed as Record<string, unknown>).result;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/** Run one `herdr` subcommand and parse its JSON reply. Never throws. */
export function runHerdr(args: string[], options: { timeoutMs?: number; spawnImpl?: SpawnLike } = {}): Promise<HerdrResult<unknown>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnImpl = options.spawnImpl ?? spawn;
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawnImpl(herdrBin(), args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve(fail("HERDR_UNAVAILABLE", `Could not start herdr: ${(error as Error).message}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: HerdrResult<unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      finish(fail("TIMEOUT", `herdr ${args.join(" ")} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    timer.unref?.();

    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    proc.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(
        fail(
          "HERDR_UNAVAILABLE",
          code === "ENOENT"
            ? "herdr is not installed or not on PATH. Install Herdr, or set HERDR_BIN."
            : error.message,
        ),
      );
    });
    proc.on("close", (exitCode) => {
      if (exitCode !== 0) {
        finish(fail("INVALID_RESPONSE", stderr.trim() || `herdr ${args[0] ?? ""} exited with code ${exitCode}.`));
        return;
      }
      finish({ ok: true, data: unwrap(stdout) });
    });
  });
}

function extractPaneId(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const pane =
    record.pane && typeof record.pane === "object" && !Array.isArray(record.pane)
      ? (record.pane as Record<string, unknown>)
      : record;
  for (const key of ["pane_id", "paneId", "id"]) {
    const value = pane[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function quoteArg(value: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Build a single shell-quoted command string for `herdr pane run`, which executes it
 * through the pane's own shell. Every argument must come from values we generate
 * ourselves (paths, flags) -- never from model or user-controlled text -- so quoting
 * mistakes cannot become a shell-injection path from an untrusted source.
 */
export function buildPaneCommand(exe: string, args: string[], platform: NodeJS.Platform = process.platform): string {
  return [exe, ...args].map((part) => quoteArg(part, platform)).join(" ");
}

export interface OpenInspectorPaneResult {
  ok: boolean;
  paneId?: string;
  message?: string;
}

/** Open a new Herdr pane beside the current one and run `command` in it. Best-effort; never throws. */
export async function openInspectorPane(
  options: { cwd: string; command: string; spawnImpl?: SpawnLike },
): Promise<OpenInspectorPaneResult> {
  const probe = await runHerdr(["--version"], { timeoutMs: 5_000, spawnImpl: options.spawnImpl });
  if (!probe.ok) return { ok: false, message: `Herdr is not available: ${probe.error.message}` };

  const split = await runHerdr(
    ["pane", "split", "--current", "--direction", "right", "--cwd", options.cwd, "--no-focus"],
    { spawnImpl: options.spawnImpl },
  );
  if (!split.ok) return { ok: false, message: `Could not open a Herdr pane: ${split.error.message}` };

  const paneId = extractPaneId(split.data);
  if (!paneId) return { ok: false, message: "Herdr did not return a pane id for the new pane." };

  const started = await runHerdr(["pane", "run", paneId, options.command], { spawnImpl: options.spawnImpl });
  if (!started.ok) {
    await runHerdr(["pane", "close", paneId], { timeoutMs: 5_000, spawnImpl: options.spawnImpl });
    return { ok: false, message: `Could not start the inspector in the Herdr pane: ${started.error.message}` };
  }

  return { ok: true, paneId };
}
