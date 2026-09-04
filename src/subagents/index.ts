import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ResolvedConfig } from "../config.ts";
import { toolFailure, toolText } from "../errors.ts";
import { discoverAgents, formatAgentList } from "./discover.ts";
import { fleetWidget, renderSubagentCall, renderSubagentResult } from "./render.ts";
import { emptyUsage, mapLimit, runSubagent, type ActiveRun, type RunUsage, type SubagentRunResult } from "./runner.ts";
import { effectiveOutputSchema, validateOutputSchema, type JsonSchema } from "./schema.ts";
import { validateSubagentParams, type AgentDefinition, type AgentScope } from "./types.ts";
import {
  createTemporaryWorktree,
  finishTemporaryWorktree,
  remapWorktreeCwd,
  type Isolation,
  type TemporaryWorktree,
} from "./worktree.ts";

const IsolationSchema = StringEnum(["none", "worktree"] as const);
const TaskItem = Type.Object({
  agent: Type.String({ description: "Agent name" }),
  task: Type.String({ description: "Task to delegate" }),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
  outputSchema: Type.Optional(Type.Any({ description: "TypeBox/JSON object schema for a required structured result" })),
  isolation: Type.Optional(IsolationSchema),
});

interface Job {
  agent: string;
  task: string;
  cwd?: string;
  outputSchema?: unknown;
  isolation?: Isolation;
}

export function aggregateRunUsage(results: SubagentRunResult[]) {
  const total = results.reduce<RunUsage>((usage, result) => {
    usage.input += result.usage.input;
    usage.output += result.usage.output;
    usage.cacheRead += result.usage.cacheRead;
    usage.cacheWrite += result.usage.cacheWrite;
    usage.cost += result.usage.cost;
    usage.costInput = (usage.costInput ?? 0) + (result.usage.costInput ?? 0);
    usage.costOutput = (usage.costOutput ?? 0) + (result.usage.costOutput ?? 0);
    usage.costCacheRead = (usage.costCacheRead ?? 0) + (result.usage.costCacheRead ?? 0);
    usage.costCacheWrite = (usage.costCacheWrite ?? 0) + (result.usage.costCacheWrite ?? 0);
    usage.turns += result.usage.turns;
    return usage;
  }, emptyUsage());
  return {
    input: total.input,
    output: total.output,
    cacheRead: total.cacheRead,
    cacheWrite: total.cacheWrite,
    totalTokens: total.input + total.output + total.cacheRead + total.cacheWrite,
    cost: {
      input: total.costInput ?? 0,
      output: total.costOutput ?? 0,
      cacheRead: total.costCacheRead ?? 0,
      cacheWrite: total.costCacheWrite ?? 0,
      total: total.cost,
    },
  };
}

/** Spinner/elapsed refresh rate for the FleetView widget. */
const WIDGET_TICK_MS = 120;

export function registerSubagents(pi: ExtensionAPI, config: ResolvedConfig): void {
  const active = new Map<string, ActiveRun>();
  let spawnedThisSession = 0;
  let ticker: NodeJS.Timeout | undefined;
  let lastCtx: ExtensionContext | undefined;
  let collapsed = false;

  const renderFleet = (ctx: ExtensionContext) => {
    lastCtx = ctx;
    if (!ctx.hasUI) return;
    if (active.size === 0) {
      ctx.ui.setWidget("pi-essentials-subagents", undefined);
      return;
    }
    const runs = [...active.values()];
    const options = { collapsed, spawned: spawnedThisSession, budget: config.subagents.spawnBudget };
    ctx.ui.setWidget(
      "pi-essentials-subagents",
      (_tui, theme) => new Text(fleetWidget(theme, runs, options).join("\n"), 0, 0),
      { placement: "belowEditor" },
    );
  };

  // Elapsed times would otherwise only advance when a child emits progress.
  const syncTicker = () => {
    if (active.size > 0 && !ticker) {
      ticker = setInterval(() => {
        if (lastCtx) renderFleet(lastCtx);
      }, WIDGET_TICK_MS);
      ticker.unref?.();
      return;
    }
    if (active.size === 0 && ticker) {
      clearInterval(ticker);
      ticker = undefined;
    }
  };

  const stopAll = () => {
    for (const run of active.values()) run.proc?.kill("SIGTERM");
    active.clear();
    if (ticker) clearInterval(ticker);
    ticker = undefined;
  };

  pi.on("session_start", async (_event, ctx) => {
    spawnedThisSession = 0;
    stopAll();
    lastCtx = ctx;
    renderFleet(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopAll();
  });

  pi.registerShortcut("ctrl+shift+a", {
    description: "Collapse or expand the pi-essentials subagent fleet panel",
    handler: async (ctx) => {
      collapsed = !collapsed;
      renderFleet(ctx);
    },
  });

  pi.registerCommand("subagents", {
    description: "List agents and running subagent jobs. Usage: /subagents [cancel <id>|cancel all]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts[0] === "cancel") {
        const target = parts[1];
        if (!target) {
          ctx.ui.notify("Usage: /subagents cancel <id|all>", "warning");
          return;
        }
        if (target === "all") {
          const count = active.size;
          stopAll();
          renderFleet(ctx);
          ctx.ui.notify(count > 0 ? `Cancelled ${count} subagent(s)` : "No running subagents.", "info");
          return;
        }
        const run = active.get(target);
        if (!run?.proc) {
          ctx.ui.notify(`No running subagent "${target}".`, "warning");
          return;
        }
        run.proc.kill("SIGTERM");
        ctx.ui.notify(`Cancelled ${target}`, "info");
        return;
      }
      if (parts.length > 0) {
        ctx.ui.notify("Usage: /subagents [cancel <id|all>]", "warning");
        return;
      }
      const agents = discoverAgents(ctx.cwd, "both");
      const running =
        active.size === 0
          ? "No running subagents."
          : [...active.values()]
              .map((r) => `${r.id}  ${r.agent}  ${Math.round((Date.now() - r.startedAt) / 1000)}s — ${truncate(r.task, 60)}`)
              .join("\n");
      const budget = `Spawned ${spawnedThisSession}/${config.subagents.spawnBudget} this session.`;
      ctx.ui.notify(`${running}\n${budget}\n\nAgents:\n${formatAgentList(agents)}`, "info");
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate an isolated task to a subagent (scout, reviewer, worker, oracle, or a custom agent). Modes: single {agent,task}, parallel {tasks:[...]}, chain {chain:[...]}. Optional outputSchema requires a structured result; isolation can use a temporary git worktree. Returns only the child's final answer.",
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
      agentScope: Type.Optional(
        StringEnum(["user", "project", "both"] as const, {
          description: "Where to look for custom agents. Defaults to user (builtins plus ~/.pi/agent/agents).",
        }),
      ),
      confirmProjectAgents: Type.Optional(Type.Boolean()),
      cwd: Type.Optional(Type.String()),
      outputSchema: Type.Optional(Type.Any({ description: "Default TypeBox/JSON object schema for structured results" })),
      isolation: Type.Optional(IsolationSchema),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const scope: AgentScope = params.agentScope ?? "user";
      const agents = discoverAgents(ctx.cwd, scope);
      const validated = validateSubagentParams(params);
      if ("error" in validated) {
        toolFailure(`${validated.error}\nAvailable agents:\n${formatAgentList(agents)}`, "SUBAGENT_BAD_ARGS");
      }

      const jobs: Job[] =
        validated.mode === "single"
          ? [{ agent: params.agent ?? "", task: params.task ?? "", cwd: params.cwd, outputSchema: params.outputSchema, isolation: params.isolation }]
          : validated.mode === "parallel"
            ? (params.tasks ?? [])
            : (params.chain ?? []);

      if (jobs.length === 0) toolFailure("No subagent jobs provided.", "SUBAGENT_BAD_ARGS");

      let rootSchema: JsonSchema | undefined;
      const jobSchemas: Array<JsonSchema | undefined> = [];
      try {
        rootSchema = params.outputSchema === undefined ? undefined : validateOutputSchema(params.outputSchema);
        for (const job of jobs) jobSchemas.push(effectiveOutputSchema(job.outputSchema, rootSchema));
      } catch (error) {
        toolFailure((error as Error).message, "SUBAGENT_BAD_SCHEMA");
      }

      const blank = jobs.findIndex((job) => !job.agent?.trim() || !job.task?.trim());
      if (blank >= 0) toolFailure(`Job ${blank + 1} is missing an agent name or task text.`, "SUBAGENT_BAD_ARGS");

      // Resolve every agent up front so a typo does not consume the spawn budget.
      const unknown = [...new Set(jobs.map((job) => job.agent))].filter((name) => !agents.some((a) => a.name === name));
      if (unknown.length > 0) {
        toolFailure(
          `Unknown agent(s): ${unknown.join(", ")}.\nAvailable agents:\n${formatAgentList(agents)}`,
          "SUBAGENT_UNKNOWN_AGENT",
        );
      }

      if (validated.mode === "parallel" && jobs.length > config.subagents.maxParallel) {
        toolFailure(
          `Too many parallel tasks (${jobs.length}); the limit is ${config.subagents.maxParallel}.`,
          "SUBAGENT_TOO_MANY",
        );
      }
      const remaining = config.subagents.spawnBudget - spawnedThisSession;
      if (jobs.length > remaining) {
        toolFailure(
          `Subagent spawn budget exhausted: ${spawnedThisSession}/${config.subagents.spawnBudget} used this session, ` +
            `${remaining} left but ${jobs.length} requested. Raise subagents.spawnBudget to allow more.`,
          "SUBAGENT_BUDGET",
        );
      }

      const projectAgents = [...new Set(jobs.map((job) => job.agent))]
        .map((name) => agents.find((a) => a.name === name))
        .filter((a): a is AgentDefinition => a?.source === "project");

      if (projectAgents.length > 0 && (params.confirmProjectAgents ?? true) && !ctx.isProjectTrusted()) {
        if (!ctx.hasUI) {
          toolFailure(
            `Refusing to run project-local agent(s) ${projectAgents.map((a) => a.name).join(", ")} in an untrusted project without a way to confirm.`,
            "SUBAGENT_UNTRUSTED",
          );
        }
        const ok = await ctx.ui.confirm(
          "Project subagents",
          `Run project-local agent(s) ${projectAgents.map((a) => a.name).join(", ")}? These prompts come from this repository.`,
        );
        if (!ok) toolFailure("User declined to run project-local subagents.", "SUBAGENT_DECLINED");
      }

      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const thinkingLevel = ctx.thinkingLevel ? String(ctx.thinkingLevel) : undefined;

      const isolationFor = (job: Job): Isolation => job.isolation ?? params.isolation ?? "none";
      const sourceCwdFor = (job: Job): string => job.cwd ?? params.cwd ?? ctx.cwd;

      const runOne = async (
        job: Job,
        previous = "",
        sharedWorktree?: TemporaryWorktree,
        jobIndex = jobs.indexOf(job),
      ): Promise<SubagentRunResult> => {
        const agent = agents.find((a) => a.name === job.agent);
        if (!agent) {
          return {
            id: `missing-${job.agent}`,
            agent: job.agent,
            task: job.task,
            exitCode: 1,
            output: "",
            outputKind: jobSchemas[jobIndex] ? "structured" : "text",
            stderr: "",
            usage: emptyUsage(),
            error: `Unknown agent "${job.agent}".`,
            running: false,
            durationMs: 0,
          };
        }
        const isolation = isolationFor(job);
        const ownedWorktree = isolation === "worktree" && !sharedWorktree
          ? createTemporaryWorktree(sourceCwdFor(job))
          : undefined;
        const worktree = sharedWorktree ?? ownedWorktree;
        let result: SubagentRunResult;
        try {
          const runCwd = worktree && isolation === "worktree"
            ? remapWorktreeCwd(sourceCwdFor(job), worktree)
            : sourceCwdFor(job);
          spawnedThisSession += 1;
          result = await runSubagent({
            agent,
            task: job.task.replaceAll("{previous}", previous),
            cwd: runCwd,
            model,
            thinkingLevel,
            config: config.subagents,
            signal,
            outputSchema: jobSchemas[jobIndex],
            onProgress: (partial) => {
              onUpdate?.(toolText(`${agent.name}: ${truncate(partial, 800)}`));
            },
            register: (run) => {
              active.set(run.id, run);
              syncTicker();
              renderFleet(ctx);
            },
            unregister: (id) => {
              active.delete(id);
              syncTicker();
              renderFleet(ctx);
            },
          });
        } finally {
          if (ownedWorktree) {
            const metadata = finishTemporaryWorktree(ownedWorktree);
            if (result!) result.worktree = metadata;
          }
        }
        return result;
      };

      let results: SubagentRunResult[] = [];
      try {
        if (validated.mode === "chain") {
          let previous = "";
          const firstIsolated = jobs.find((job) => isolationFor(job) === "worktree");
          const sharedWorktree = firstIsolated ? createTemporaryWorktree(sourceCwdFor(firstIsolated)) : undefined;
          try {
            for (let index = 0; index < jobs.length; index++) {
              const job = jobs[index];
              const result = await runOne(job, previous, isolationFor(job) === "worktree" ? sharedWorktree : undefined, index);
              results.push(result);
              if (result.exitCode !== 0) break;
              previous = result.outputKind === "structured"
                ? JSON.stringify(result.structuredOutput)
                : result.output;
            }
          } finally {
            if (sharedWorktree) {
              const metadata = finishTemporaryWorktree(sharedWorktree);
              for (let index = 0; index < results.length; index++) {
                if (isolationFor(jobs[index]) === "worktree") results[index].worktree = metadata;
              }
            }
          }
        } else if (validated.mode === "parallel") {
          results = await mapLimit(jobs, config.subagents.maxConcurrency, (job, index) => runOne(job, "", undefined, index));
        } else {
          results = [await runOne(jobs[0], "", undefined, 0)];
        }
      } finally {
        renderFleet(ctx);
      }

      const skipped = jobs.length - results.length;
      const text = [
        ...results.map((result) => {
          const status = result.exitCode === 0 ? "" : " (failed)";
          const body = result.exitCode !== 0 && result.error ? result.error : result.output;
          return `## ${result.agent}${status}\n${body}`;
        }),
        ...(skipped > 0 ? [`_${skipped} later chain step(s) skipped after a failure._`] : []),
      ].join("\n\n");

      if (results.length > 0 && results.every((result) => result.exitCode !== 0)) {
        toolFailure(
          `Every subagent failed.\n\n${text}`,
          results.length === 1 ? "SUBAGENT_FAILED" : "SUBAGENT_ALL_FAILED",
        );
      }

      return toolText(text || "(no subagent output)", {
        mode: validated.mode,
        skipped,
        results: results.map((r) => ({
          id: r.id,
          agent: r.agent,
          exitCode: r.exitCode,
          durationMs: r.durationMs,
          usage: r.usage,
          model: r.model,
          error: r.error,
          outputKind: r.outputKind,
          structuredOutput: r.structuredOutput,
          worktree: r.worktree,
        })),
      }, aggregateRunUsage(results));
    },
    renderCall: renderSubagentCall,
    renderResult: renderSubagentResult,
  });
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
