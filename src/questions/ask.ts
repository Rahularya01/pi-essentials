import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isMultiple, type QuestionAnswer, type QuestionOption, type QuestionSpec } from "./validate.ts";

const OTHER_LABEL = "Other (type your own answer)";
const DONE_LABEL = "Done (finish this question)";

export interface AskResult {
  answers: QuestionAnswer[];
  cancelled: boolean;
}

/**
 * Options are shown with a numeric prefix so every entry is unique, which lets the
 * selection be mapped back by array index instead of by parsing the label text.
 */
export function displayOptions(options: QuestionOption[]): string[] {
  return options.map((option, index) => {
    const description = option.description?.trim();
    return `${index + 1}. ${option.label}${description ? ` — ${description}` : ""}`;
  });
}

export async function askQuestions(
  ctx: ExtensionContext,
  questions: QuestionSpec[],
  signal?: AbortSignal,
): Promise<AskResult> {
  if (!ctx.hasUI) return { answers: [], cancelled: true };

  const answers: QuestionAnswer[] = [];
  for (const question of questions) {
    if (signal?.aborted) return { answers, cancelled: true };
    const answer = isMultiple(question)
      ? await askMultiSelect(ctx, question, signal)
      : await askSingle(ctx, question, signal);
    if (!answer) return { answers, cancelled: true };
    answers.push(answer);
  }
  return { answers, cancelled: false };
}

async function askSingle(
  ctx: ExtensionContext,
  question: QuestionSpec,
  signal?: AbortSignal,
): Promise<QuestionAnswer | undefined> {
  const labels = [...displayOptions(question.options), ...(question.allowOther === false ? [] : [OTHER_LABEL])];
  // Pi's select API currently has no initial-index option, so `recommended`
  // remains metadata and option order/display stay backward compatible.
  const picked = await ctx.ui.select(question.question, labels, { signal });
  if (picked === undefined || picked === null) return undefined;

  const index = labels.indexOf(String(picked));
  if (index === -1) return undefined;
  if (question.allowOther !== false && index === question.options.length) {
    const custom = await askCustom(ctx, question, signal);
    return custom === undefined
      ? undefined
      : answerBase(question, [], [], custom);
  }
  const option = question.options[index];
  if (!option) return undefined;
  return answerBase(question, [option.label], [index]);
}

async function askMultiSelect(
  ctx: ExtensionContext,
  question: QuestionSpec,
  signal?: AbortSignal,
): Promise<QuestionAnswer | undefined> {
  const remaining = question.options.map((option, index) => ({ option, index }));
  const selected: string[] = [];
  const selectedIndices: number[] = [];
  let custom: string | undefined;

  while (remaining.length > 0) {
    const rows = remaining.map(({ option, index }) => {
      const description = option.description?.trim();
      return `${index + 1}. ${option.label}${description ? ` — ${description}` : ""}`;
    });
    const labels = [
      ...rows,
      ...(question.allowOther === false ? [] : [OTHER_LABEL]),
      ...(selected.length > 0 || custom ? [DONE_LABEL] : []),
    ];
    const title = selected.length > 0 ? `${question.question} (selected: ${selected.join(", ")})` : question.question;

    const picked = await ctx.ui.select(title, labels, { signal });
    if (picked === undefined || picked === null) return undefined;
    const choice = String(picked);
    if (choice === DONE_LABEL) break;
    if (question.allowOther !== false && choice === OTHER_LABEL) {
      const typed = await askCustom(ctx, question, signal);
      if (typed === undefined) return undefined;
      custom = custom ? `${custom}; ${typed}` : typed;
      continue;
    }
    const position = rows.indexOf(choice);
    if (position === -1) return undefined;
    selected.push(remaining[position].option.label);
    selectedIndices.push(remaining[position].index);
    remaining.splice(position, 1);
  }

  if (selected.length === 0 && !custom) return undefined;
  return answerBase(question, selected, selectedIndices, custom);
}

function answerBase(
  question: QuestionSpec,
  selected: string[],
  selectedIndices: number[],
  custom?: string,
): QuestionAnswer {
  return {
    id: question.id,
    question: question.question,
    header: question.header,
    selected,
    selectedIndices,
    selectedValues: selectedIndices.map((index) => question.options[index]?.value ?? question.options[index]?.label ?? ""),
    custom,
  };
}

async function askCustom(
  ctx: ExtensionContext,
  question: QuestionSpec,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const typed = await ctx.ui.input(question.header?.trim() || "Your answer", "", { signal });
  const value = typed === undefined || typed === null ? "" : String(typed).trim();
  return value.length > 0 ? value : undefined;
}
