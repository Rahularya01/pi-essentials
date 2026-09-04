import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ResolvedConfig } from "../config.ts";
import { toolError, toolText } from "../errors.ts";
import { discoverAgents, formatAgentList } from "./discover.ts";
import { mapLimit, runSubagent, type ActiveRun, type SubagentRunResult } from "./runner.ts";
import { validateSubagentParams, type AgentDefinition, type AgentScope } from "./types.ts";

const TaskItem = Type.Object({
  agent: Type.String({ description: "Agent name" }),
  task: Type.String({ description: "Task to delegate" }),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
});

export function registerSubagents(pi: ExtensionAPI, config: ResolvedConfig): void {
  const active = new Map<string, ActiveRun>();
  let spawnedThisSession = 0;

  const renderFleet = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (active.size === 0) {
      ctx.ui.setWidget("pi-essentials-subagents", undefined);
      return;
    }
    const lines = [`Subagents (${active.size} running)`];
    for (const run of active.values()) {
      const elapsed = Math.round((Date.now() - run.startedAt) / 1000);
      lines.push(`• ${run.agent} ${elapsed}s — ${truncate(run.task, 60)}`);
    }
    ctx.ui.setWidget("pi-essentials-subagents", lines);
  };

  pi.on("session_start", async () => {
    spawnedThisSession = 0;
    active.clear();
  });

  pi.registerCommand("subagents", {
    description: "List builtin/user agents or running subagent jobs. Usage: /subagents [cancel <id>]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts[0] === "cancel" && parts[1]) {
        const run = active.get(parts[1]);
        if (!run?.proc) {
          ctx.ui.notify(`No running subagent ${parts[1]}`, "warning");
          return;
        }
        run.proc.kill("SIGTERM");
        ctx.ui.notify(`Cancelled ${parts[1]}`, "info");
        return;
      }
      const agents = discoverAgents(ctx.cwd, "both");
      const running =
        active.size === 0
          ? "No running subagents."
          : [...active.values()].map((r) => `${r.id} ${r.agent} — ${r.task}`).join("\n");
      ctx.ui.notify(`${running}\n\nAgents:\n${formatAgentList(agents)}`, "info");
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate an isolated task to a subagent (scout, reviewer, worker, oracle, or a custom agent). Modes: single {agent,task}, parallel {tasks:[...]}, chain {chain:[...]}. Returns only the child's final answer.",
    promptSnippet: "Delegate isolated work to scout, reviewer, worker, or oracle subagents",
    promptGuidelines: [
      "Use subagent for bounded work that should not pollute the parent context, especially recon, review, and second opinions.",
      "Pass only the task the child needs. Do not paste the full parent transcript.",
      "Prefer scout before planning, worker to implement, reviewer to check, and oracle when the decision is risky.",
    ],
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Agent name for single mode" })),
      task: Type.Optional(Type.String({ description: "Task for single mode" })),
      tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks" })),
      chain: Type.Optional(Type.Array(TaskItem, { description: "Sequential tasks; use {previous} in later prompts" })),
      agentScope: Type.Optional(StringEnum(["user", "project", "both"] as const)),
      confirmProjectAgents: Type.Optional(Type.Boolean()),
      cwd: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const validated = validateSubagentParams(params);
      const scope: AgentScope = params.agentScope ?? "user";
      const agents = discoverAgents(ctx.cwd, scope);
      if ("error" in validated) {
        return toolError(`${validated.error}\nAvailable agents:\n${formatAgentList(agents)}`);
      }

      const requestedNames = requestedAgentNames(params);
      const projectAgents = requestedNames
        .map((name) => agents.find((a) => a.name === name))
        .filter((a): a is AgentDefinition => a?.source === "project");

      if (
        projectAgents.length > 0 &&
        (params.confirmProjectAgents ?? true) &&
        ctx.hasUI &&
        typeof ctx.isProjectTrusted === "function" &&
        !ctx.isProjectTrusted()
      ) {
        const ok = await ctx.ui.confirm(
          "Project subagents",
          `Run project-local agent(s) ${projectAgents.map((a) => a.name).join(", ")}? These prompts come from this repository.`,
        );
        if (!ok) return toolError("User declined to run project-local subagents.");
      }

      const jobs: Array<{ agent: string; task: string; cwd?: string }> =
        validated.mode === "single"
          ? [{ agent: params.agent ?? "", task: params.task ?? "", cwd: params.cwd }]
          : validated.mode === "parallel"
            ? (params.tasks ?? [])
            : (params.chain ?? []);

      if (jobs.length === 0) return toolError("No subagent jobs provided.");
      if (validated.mode === "parallel" && jobs.length > config.subagents.maxParallel) {
        return toolError(`Too many parallel tasks (max ${config.subagents.maxParallel}).`);
      }
      if (spawnedThisSession + jobs.length > config.subagents.spawnBudget) {
        return toolError(`Subagent spawn budget exceeded (max ${config.subagents.spawnBudget} per session).`);
      }

      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const thinkingLevel = ctx.thinkingLevel ? String(ctx.thinkingLevel) : undefined;
      spawnedThisSession += jobs.length;

      const runOne = async (job: { agent: string; task: string; cwd?: string }, previous = ""): Promise<SubagentRunResult> => {
        const agent = agents.find((a) => a.name === job.agent);
        if (!agent) {
          return {
            id: "missing",
            agent: job.agent,
            task: job.task,
            exitCode: 1,
            output: "",
            stderr: "",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
            error: `Unknown agent "${job.agent}". Available:\n${formatAgentList(agents)}`,
            running: false,
          };
        }
        const task = job.task.replaceAll("{previous}", previous);
        return runSubagent({
          agent,
          task,
          cwd: job.cwd ?? params.cwd ?? ctx.cwd,
          model,
          thinkingLevel,
          config: config.subagents,
          signal,
          onProgress: (partial) => {
            onUpdate?.(toolText(`${agent.name}: ${truncate(partial, 800)}`));
            renderFleet(ctx);
          },
          register: (run) => {
            active.set(run.id, run);
            renderFleet(ctx);
          },
          unregister: (id) => {
            active.delete(id);
            renderFleet(ctx);
          },
        });
      };

      let results: SubagentRunResult[] = [];
      if (validated.mode === "chain") {
        let previous = "";
        for (const job of jobs) {
          const result = await runOne(job, previous);
          results.push(result);
          previous = result.output;
          if (result.exitCode !== 0) break;
        }
      } else if (validated.mode === "parallel") {
        results = await mapLimit(jobs, config.subagents.maxConcurrency, (job) => runOne(job));
      } else {
        results = [await runOne(jobs[0])];
      }

      const text = results
        .map((result) => {
          const header = `## ${result.agent}${result.exitCode === 0 ? "" : " (failed)"}`;
          const body = result.error && result.exitCode !== 0 ? result.error : result.output;
          return `${header}\n${body}`;
        })
        .join("\n\n");

      return toolText(text, {
        mode: validated.mode,
        results: results.map((r) => ({
          agent: r.agent,
          exitCode: r.exitCode,
          usage: r.usage,
          model: r.model,
          error: r.error,
        })),
      });
    },
  });
}

function requestedAgentNames(params: {
  agent?: string;
  tasks?: Array<{ agent: string }>;
  chain?: Array<{ agent: string }>;
}): string[] {
  const names = new Set<string>();
  if (params.agent) names.add(params.agent);
  for (const job of params.tasks ?? []) names.add(job.agent);
  for (const job of params.chain ?? []) names.add(job.agent);
  return [...names];
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
