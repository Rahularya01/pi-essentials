import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResolvedSubagentsConfig } from "../config.ts";
import { capText } from "../errors.ts";
import { sanitizeEnv } from "../security/env.ts";
import type { AgentDefinition } from "./types.ts";

export interface RunUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface SubagentRunResult {
  id: string;
  agent: string;
  task: string;
  exitCode: number;
  output: string;
  stderr: string;
  usage: RunUsage;
  model?: string;
  error?: string;
  running: boolean;
}

export interface ActiveRun {
  id: string;
  agent: string;
  task: string;
  startedAt: number;
  proc?: ReturnType<typeof spawn>;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

function writePrompt(agentName: string, prompt: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-essentials-subagent-"));
  const file = path.join(dir, `${agentName.replace(/[^\w.-]+/g, "_")}.md`);
  fs.writeFileSync(file, prompt, { encoding: "utf8", mode: 0o600 });
  return { dir, file };
}

function cleanupPrompt(dir: string, file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // ignore
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    // ignore
  }
}

function finalAssistantText(messages: Array<{ role?: string; content?: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const texts = msg.content
      .filter((part): part is { type: string; text: string } => Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
      .map((part) => part.text);
    if (texts.length > 0) return texts.join("\n");
  }
  return "";
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
  onProgress?: (partial: string) => void;
  register?: (run: ActiveRun) => void;
  unregister?: (id: string) => void;
}): Promise<SubagentRunResult> {
  const id = `${options.agent.name}-${Date.now().toString(36)}`;
  const args = ["--mode", "json", "-p", "--no-session"];
  const model = options.agent.model ?? options.model;
  if (model) args.push("--model", model);
  if (!options.agent.model && options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
  if (options.agent.tools?.length) args.push("--tools", options.agent.tools.join(","));

  let promptDir: string | undefined;
  let promptFile: string | undefined;
  if (options.agent.systemPrompt.trim()) {
    const written = writePrompt(options.agent.name, options.agent.systemPrompt);
    promptDir = written.dir;
    promptFile = written.file;
    args.push("--append-system-prompt", promptFile);
  }
  args.push(`Task: ${options.task}`);

  const usage: RunUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  const messages: Array<{ role?: string; content?: unknown }> = [];
  let stderr = "";
  let childModel = model;
  let error: string | undefined;

  const invocation = getPiInvocation(args);
  const env = sanitizeEnv(process.env, {
    PI_ESSENTIALS_SUBAGENT: "1",
    PI_ESSENTIALS_NEST_DEPTH: String(Number(process.env.PI_ESSENTIALS_NEST_DEPTH ?? "0") + 1),
    ...options.envExtra,
  });

  const result = await new Promise<number>((resolve) => {
    const proc = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    options.register?.({ id, agent: options.agent.name, task: options.task, startedAt: Date.now(), proc });
    let buffer = "";

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (!event || typeof event !== "object") return;
      const rec = event as { type?: string; message?: { role?: string; content?: unknown; usage?: Record<string, number>; model?: string; stopReason?: string; errorMessage?: string; cost?: { total?: number } } };
      if (rec.type === "message_end" && rec.message) {
        messages.push(rec.message);
        if (rec.message.role === "assistant") {
          usage.turns += 1;
          const u = rec.message.usage;
          if (u) {
            usage.input += u.input ?? 0;
            usage.output += u.output ?? 0;
            usage.cacheRead += u.cacheRead ?? 0;
            usage.cacheWrite += u.cacheWrite ?? 0;
            usage.cost += rec.message.cost?.total ?? (u as { cost?: number }).cost ?? 0;
          }
          if (rec.message.model) childModel = rec.message.model;
          if (rec.message.errorMessage) error = rec.message.errorMessage;
        }
        options.onProgress?.(finalAssistantText(messages) || "(running...)");
      }
    };

    proc.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("close", (code) => {
      if (buffer.trim()) handleLine(buffer);
      resolve(code ?? 0);
    });
    proc.on("error", (err) => {
      error = err.message;
      resolve(1);
    });

    if (options.signal) {
      const kill = () => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000).unref();
      };
      if (options.signal.aborted) kill();
      else options.signal.addEventListener("abort", kill, { once: true });
    }
  });

  options.unregister?.(id);
  if (promptDir && promptFile) cleanupPrompt(promptDir, promptFile);

  const output = capText(finalAssistantText(messages) || error || stderr || "(no output)", 32_000).text;
  return {
    id,
    agent: options.agent.name,
    task: options.task,
    exitCode: result,
    output,
    stderr: stderr.slice(0, 4000),
    usage,
    model: childModel,
    error,
    running: false,
  };
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];
  const concurrency = Math.max(1, Math.min(limit, items.length));
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
