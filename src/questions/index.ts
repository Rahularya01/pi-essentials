import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toolError, toolText } from "../errors.ts";
import { askQuestions } from "./ask.ts";
import { validateQuestions, type QuestionSpec } from "./validate.ts";

const OptionSchema = Type.Object({
  label: Type.String({ description: "Option label" }),
  description: Type.Optional(Type.String({ description: "What this choice means" })),
});

const QuestionSchema = Type.Object({
  question: Type.String({ description: "Question text" }),
  header: Type.Optional(Type.String({ description: "Short header" })),
  options: Type.Array(OptionSchema, { description: "2-4 options" }),
  multiSelect: Type.Optional(Type.Boolean()),
});

export function registerQuestions(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) {
      pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "ask_user_question"));
    }
  });

  pi.registerTool({
    name: "ask_user_question",
    label: "Ask User",
    description:
      "Pause and ask the user 1-4 multiple-choice questions when a real decision is required. Always include a Type something. path. Do not use this for information you can find yourself.",
    promptSnippet: "Ask the user a structured question instead of guessing",
    promptGuidelines: [
      "Use ask_user_question when a genuine user decision is required and guessing would be expensive to undo.",
      "Do not use ask_user_question for facts you can inspect in the repo or look up with web_search.",
    ],
    parameters: Type.Object({
      questions: Type.Array(QuestionSchema, { description: "1-4 questions" }),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const questions = params.questions as QuestionSpec[];
      const invalid = validateQuestions(questions);
      if (invalid) return toolError(invalid, { answers: [], cancelled: true, error: invalid });
      if (!ctx.hasUI) {
        return toolError("Cannot ask the user in non-interactive mode.", { answers: [], cancelled: true });
      }
      const result = await askQuestions(ctx, questions);
      return toolText(result.cancelled ? "User cancelled the questionnaire." : formatForModel(result.answers), {
        answers: result.answers,
        cancelled: result.cancelled,
      });
    },
  });
}

function formatForModel(answers: Array<{ question: string; selected: string[]; custom?: string }>): string {
  return answers
    .map((answer) => {
      if (answer.custom) return `Q: ${answer.question}\nA: ${answer.custom}`;
      return `Q: ${answer.question}\nA: ${answer.selected.join(", ")}`;
    })
    .join("\n\n");
}
