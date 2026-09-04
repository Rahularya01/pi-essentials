import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatAnswers, type QuestionAnswer, type QuestionSpec } from "./validate.ts";

const OTHER = "Type something.";

export async function askQuestions(ctx: ExtensionContext, questions: QuestionSpec[]): Promise<{
  answers: QuestionAnswer[];
  cancelled: boolean;
}> {
  if (ctx.mode === "rpc") {
    return askViaHostDialogs(ctx, questions);
  }
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    return { answers: [], cancelled: true };
  }

  const answers: QuestionAnswer[] = [];
  for (const question of questions) {
    const labels = [...question.options.map((o) => displayOption(o)), OTHER];
    const picked = await ctx.ui.select(question.question, labels);
    if (picked === undefined || picked === null) {
      return { answers, cancelled: true };
    }
    const value = String(picked);
    if (value === OTHER) {
      const custom = await ctx.ui.input("Your answer", "");
      if (custom === undefined || custom === null || !String(custom).trim()) {
        return { answers, cancelled: true };
      }
      answers.push({ question: question.question, header: question.header, selected: [], custom: String(custom).trim() });
      continue;
    }
    const selected = stripDescription(value);
    if (question.multiSelect) {
      const more = await ctx.ui.confirm("Add another option?", `Already selected: ${selected}`);
      const selectedAll = [selected];
      if (more) {
        const second = await ctx.ui.select("Additional option (or skip via Type something. then empty to stop)", labels);
        if (second && String(second) !== OTHER) selectedAll.push(stripDescription(String(second)));
      }
      answers.push({ question: question.question, header: question.header, selected: selectedAll });
    } else {
      answers.push({ question: question.question, header: question.header, selected: [selected] });
    }
  }
  return { answers, cancelled: false };
}

async function askViaHostDialogs(ctx: ExtensionContext, questions: QuestionSpec[]) {
  const answers: QuestionAnswer[] = [];
  for (const question of questions) {
    const labels = [...question.options.map((o) => displayOption(o)), OTHER];
    const picked = await ctx.ui.select(question.question, labels);
    if (picked === undefined || picked === null) return { answers, cancelled: true };
    const value = String(picked);
    if (value === OTHER) {
      const custom = await ctx.ui.input("Your answer", "");
      if (!custom?.trim()) return { answers, cancelled: true };
      answers.push({ question: question.question, header: question.header, selected: [], custom: custom.trim() });
    } else {
      answers.push({ question: question.question, header: question.header, selected: [stripDescription(value)] });
    }
  }
  return { answers, cancelled: false };
}

function displayOption(option: { label: string; description?: string }): string {
  return option.description ? `${option.label} — ${option.description}` : option.label;
}

function stripDescription(value: string): string {
  const idx = value.indexOf(" — ");
  return idx === -1 ? value : value.slice(0, idx);
}

export function answersText(answers: QuestionAnswer[], cancelled: boolean): string {
  return formatAnswers(answers, cancelled);
}
