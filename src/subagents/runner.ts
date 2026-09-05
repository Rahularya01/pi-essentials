import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResolvedSubagentsConfig } from "../config.ts";
import { capBytes } from "../errors.ts";
import { sanitizeEnv } from "../security/env.ts";
import { applySessionEvent, emptyTrace, type TraceEvent } from "./activity.ts";
import type { JsonSchema } from "./schema.ts";
import type { AgentDefinition } from "./types.ts";
import type { WorktreeMetadata } from "./worktree.ts";

/** Grace period between SIGTERM and SIGKILL when a run is cancelled. */
const KILL_GRACE_MS = 5_000;

/** How long a finished run's event log survives, so a Herdr pane opened just after completion still works. */
const LOG_RETENTION_MS = 60_000;

export interface RunUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costInput?: number;
  costOutput?: number;
  costCacheRead?: number;
  costCacheWrite?: number;
  turns: number;
}

export interface SubagentRunResult {
  id: string;
  agent: string;
  task: string;
  exitCode: number;
  output: string;
  structuredOutput?: unknown;
  outputKind: "text" | "structured";
  stderr: string;
  usage: RunUsage;
  worktree?: WorktreeMetadata;
  model?: string;
  error?: string;
  running: boolean;
  durationMs: number;
}

export interface ActiveRun {
  id: string;
  agent: string;
  task: string;
  startedAt: number;
  proc?: ReturnType<typeof spawn>;
  /** One-line current action (tool or last assistant snippet). */
  activity: string;
  /** Structured live transcript for the inspector. */
  events: TraceEvent[];
  /** Raw NDJSON event log for this run, for the external Herdr inspector viewer. */
  logFile?: string;
}

let runCounter = 0;

export function emptyUsage(): RunUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costInput: 0,
    costOutput: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
    turns: 0,
  };
}

/**
 * Resolve `pi` on PATH ourselves. `spawn` does no PATHEXT resolution and refuses
 * to run `.cmd`/`.bat` without a shell, which we will not use for untrusted text.
 */
export function resolveOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${name}${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return undefined;
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
  // Preferred: re-run the exact script this process was started from.
  if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  // A compiled pi binary: re-exec it directly.
  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) {
    return { command: process.execPath, args };
  }
  return { command: resolveOnPath("pi") ?? "pi", args };
}

function writePrompt(agentName: string, prompt: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-essentials-subagent-"));
  const file = path.join(dir, `${agentName.replace(/[^\w.-]+/g, "_") || "agent"}.md`);
  fs.writeFileSync(file, prompt, { encoding: "utf8", mode: 0o600 });
  return { dir, file };
}

export function buildResultExtension(schema: JsonSchema): string {
  return `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\n\nconst schema = ${JSON.stringify(schema)} as any;\n\nexport default function (pi: ExtensionAPI) {\n  pi.registerTool({\n    name: "subagent_result",\n    label: "Subagent Result",\n    description: "Submit the final structured result. This must be your final action.",\n    parameters: schema,\n    async execute(_id, params) {\n      return { content: [{ type: "text", text: JSON.stringify(params) }], details: params, terminate: true };\n    },\n  });\n}\n`;
}

function cleanupPrompt(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort; the OS reclaims the temp directory anyway.
  }
}

export function finalAssistantText(messages: Array<{ role?: string; content?: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const texts = msg.content
      .filter(
        (part): part is { type: string; text: string } =>
          Boolean(part) &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text.trim())
      .filter(Boolean);
    if (texts.length > 0) return texts.join("\n");
  }
  return "";
}

interface JsonUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
}

/** Accumulate pi's JSON-mode usage, whose cost lives under `usage.cost.total`. */
export function accumulateUsage(usage: RunUsage, reported: JsonUsage | undefined): void {
  if (!reported) return;
  usage.input += reported.input ?? 0;
  usage.output += reported.output ?? 0;
  usage.cacheRead += reported.cacheRead ?? 0;
  usage.cacheWrite += reported.cacheWrite ?? 0;
  usage.cost += reported.cost?.total ?? 0;
  usage.costInput = (usage.costInput ?? 0) + (reported.cost?.input ?? 0);
  usage.costOutput = (usage.costOutput ?? 0) + (reported.cost?.output ?? 0);
  usage.costCacheRead = (usage.costCacheRead ?? 0) + (reported.cost?.cacheRead ?? 0);
  usage.costCacheWrite = (usage.costCacheWrite ?? 0) + (reported.cost?.cacheWrite ?? 0);
}

export function buildArgs(options: {
  agent: AgentDefinition;
  model?: string;
  thinkingLevel?: string;
  promptFile?: string;
  extensionFile?: string;
  structured?: boolean;
  task: string;
}): string[] {
  const args = ["--mode", "json", "--no-session"];
  const model = options.agent.model ?? options.model;
  if (model) args.push("--model", model);
  if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
  if (options.extensionFile) args.push("--extension", options.extensionFile);
  if (options.agent.tools?.length) {
    const tools = options.structured
      ? [...new Set([...options.agent.tools, "subagent_result"])]
      : options.agent.tools;
    args.push("--tools", tools.join(","));
  }
  if (options.promptFile) args.push("--append-system-prompt", options.promptFile);
  // `--` stops flag parsing so a task starting with "-" is still treated as a prompt.
  args.push("--", `Task: ${options.task}`);
  return args;
}

export async function runSubagent(options: {
  agent: AgentDefinition;
  task: string;
  cwd: string;
  model?: string;
  thinkingLevel?: string;
  config: ResolvedSubagentsConfig;
  signal?: AbortSignal;
  envExtra?: Record<string, string>;
  outputSchema?: JsonSchema;
  onProgress?: (partial: string) => void;
  register?: (run: ActiveRun) => void;
  unregister?: (id: string) => void;
}): Promise<SubagentRunResult> {
  const startedAt = Date.now();
  const id = `${options.agent.name}-${(runCounter++).toString(36)}${startedAt.toString(36).slice(-4)}`;

  let promptDir: string | undefined;
  let promptFile: string | undefined;
  const structuredGuidance = options.outputSchema
    ? "\n\nYou MUST finish by calling subagent_result exactly once with the final answer. Do not merely print JSON."
    : "";
  const systemPrompt = `${options.agent.systemPrompt}${structuredGuidance}`;
  if (systemPrompt.trim()) {
    try {
      const written = writePrompt(options.agent.name, systemPrompt);
      promptDir = written.dir;
      promptFile = written.file;
    } catch {
      // Fall back to passing the prompt inline; pi accepts text or a file path.
      promptFile = systemPrompt;
    }
  }

  let extensionFile: string | undefined;
  if (options.outputSchema) {
    if (!promptDir) promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-essentials-subagent-"));
    extensionFile = path.join(promptDir, "structured-result.ts");
    fs.writeFileSync(extensionFile, buildResultExtension(options.outputSchema), { encoding: "utf8", mode: 0o600 });
  }

  const args = buildArgs({
    agent: options.agent,
    model: options.model,
    // An agent that pins its own model should not inherit the parent's thinking level.
    thinkingLevel: options.agent.model ? undefined : options.thinkingLevel,
    promptFile,
    extensionFile,
    structured: Boolean(options.outputSchema),
    task: options.task,
  });

  const usage = emptyUsage();
  const messages: Array<{ role?: string; content?: unknown }> = [];
  let stderr = "";
  let childModel = options.agent.model ?? options.model;
  let error: string | undefined;
  let structuredOutput: unknown;
  let successfulResultCalls = 0;

  const invocation = getPiInvocation(args);
  const env = sanitizeEnv(process.env, {
    PI_ESSENTIALS_SUBAGENT: "1",
    PI_ESSENTIALS_NEST_DEPTH: String(Math.max(0, Number.parseInt(process.env.PI_ESSENTIALS_NEST_DEPTH ?? "0", 10) || 0) + 1),
    ...options.envExtra,
  });

  const exitCode = await new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(invocation.command, invocation.args, {
        cwd: options.cwd,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (spawnError) {
      error = `Could not start "${invocation.command}": ${(spawnError as Error).message}`;
      finish(1);
      return;
    }

    let logStream: fs.WriteStream | undefined;
    let logDir: string | undefined;
    let logFile: string | undefined;
    try {
      logDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-essentials-subagent-log-"));
      logFile = path.join(logDir, "events.jsonl");
      logStream = fs.createWriteStream(logFile, { mode: 0o600 });
      logStream.write(`${JSON.stringify({ type: "__meta__", agent: options.agent.name, task: options.task })}\n`);
    } catch {
      // Best-effort; the Herdr inspector just won't be available for this run.
    }

    const trace = emptyTrace();
    const run: ActiveRun = {
      id,
      agent: options.agent.name,
      task: options.task,
      startedAt,
      proc,
      activity: "",
      events: trace.events,
      logFile,
    };
    options.register?.(run);

    const publish = () => {
      run.activity = trace.activity;
      run.events = trace.events;
      options.onProgress?.(trace.activity || finalAssistantText(messages) || "(running…)");
    };

    let buffer = "";
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      logStream?.write(`${line}\n`);
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (!event || typeof event !== "object") return;
      const rec = event as {
        type?: string;
        toolName?: string;
        isError?: boolean;
        result?: { details?: unknown };
        message?: { role?: string; content?: unknown; usage?: JsonUsage; model?: string; errorMessage?: string; stopReason?: string };
      };
      if (rec.type === "tool_execution_end" && rec.toolName === "subagent_result" && !rec.isError) {
        successfulResultCalls += 1;
        structuredOutput = rec.result?.details;
        return;
      }
      const live = applySessionEvent(trace, rec);
      if (rec.type === "message_end" && rec.message) {
        messages.push(rec.message);
        if (rec.message.role === "assistant") {
          usage.turns += 1;
          accumulateUsage(usage, rec.message.usage);
          if (rec.message.model) childModel = rec.message.model;
          if (rec.message.errorMessage) error = rec.message.errorMessage;
          else if (rec.message.stopReason === "error" || rec.message.stopReason === "aborted") {
            error = `Subagent stopped with reason: ${rec.message.stopReason}.`;
          }
        } else if (rec.message.role === "toolResult") {
          accumulateUsage(usage, rec.message.usage);
        }
      }
      if (live || rec.type === "message_end") publish();
    };

    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    });
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      // Keep only the tail; a noisy child must not grow memory without bound.
      stderr = (stderr + chunk).slice(-8000);
    });

    let killTimer: NodeJS.Timeout | undefined;
    const kill = () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      proc.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const signal = options.signal;
    if (signal) {
      if (signal.aborted) kill();
      else signal.addEventListener("abort", kill, { once: true });
    }
    const detach = () => {
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", kill);
    };

    proc.on("close", (code, closeSignal) => {
      if (buffer.trim()) handleLine(buffer);
      detach();
      logStream?.end();
      if (logDir) {
        const cleanup = setTimeout(() => fs.rmSync(logDir, { recursive: true, force: true }), LOG_RETENTION_MS);
        cleanup.unref?.();
      }
      if (closeSignal && code === null) {
        error ??= `Subagent was terminated by ${closeSignal}.`;
        finish(1);
        return;
      }
      finish(code ?? 0);
    });
    proc.on("error", (err) => {
      const message = (err as NodeJS.ErrnoException).code === "ENOENT"
        ? `Could not find the "pi" executable to run subagents. Ensure pi is on PATH.`
        : err.message;
      error = message;
      detach();
      finish(1);
    });
  });

  options.unregister?.(id);
  if (promptDir) cleanupPrompt(promptDir);

  const answer = finalAssistantText(messages);
  if (options.outputSchema && successfulResultCalls === 0) {
    error ??= "Structured subagent run ended without a successful subagent_result call.";
  } else if (!options.outputSchema && !answer && !error) {
    error = stderr.trim()
      ? `Subagent produced no answer. stderr:\n${stderr.trim()}`
      : "Subagent completed without an assistant answer.";
  }
  const outputKind = options.outputSchema ? "structured" : "text";
  const authoritativeOutput = options.outputSchema && successfulResultCalls > 0
    ? JSON.stringify(structuredOutput)
    : answer;
  const fallback = error ?? "(no output)";
  return {
    id,
    agent: options.agent.name,
    task: options.task,
    exitCode: error ? (exitCode || 1) : exitCode,
    output: capBytes(authoritativeOutput || fallback, options.config.maxOutputBytes).text,
    structuredOutput: options.outputSchema && successfulResultCalls > 0 ? structuredOutput : undefined,
    outputKind,
    stderr: stderr.slice(-4000),
    usage,
    model: childModel,
    error,
    running: false,
    durationMs: Date.now() - startedAt,
  };
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];
  const concurrency = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index], index);
      }
    }),
  );
  return results;
}
