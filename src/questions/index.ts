import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { errorMessage, toolFailure, toolText } from "../errors.ts";
import { MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS } from "../security/limits.ts";
import { askQuestions } from "./ask.ts";
import { renderAskCall, renderAskResult } from "./render.ts";
import { formatAnswers, validateQuestions, type QuestionSpec } from "./validate.ts";

const OptionSchema = Type.Object({
  label: Type.String({ description: "Option label" }),
  description: Type.Optional(Type.String({ description: "What this choice means" })),
  value: Type.Optional(Type.String({ description: "Machine-readable value returned for this option" })),
});

const QuestionSchema = Type.Object({
  id: Type.Optional(Type.String({ description: "Caller-defined question id, echoed in the answer" })),
  question: Type.String({ description: "Question text" }),
  header: Type.Optional(Type.String({ description: "Short header, shown as the input title" })),
  options: Type.Array(OptionSchema, { description: `${MIN_OPTIONS}-${MAX_OPTIONS} options` }),
  multiSelect: Type.Optional(Type.Boolean({ description: "Allow picking several options" })),
  multiple: Type.Optional(Type.Boolean({ description: "Alias for multiSelect; must agree if both are present" })),
  recommended: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based recommended option index" })),
  allowOther: Type.Optional(Type.Boolean({ description: "Allow a free-form answer (default true)" })),
});

export function registerQuestions(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    // Nothing can answer in print/JSON mode, so keep the tool out of the model's list.
    if (ctx.hasUI) return;
    const active = pi.getActiveTools();
    if (active.includes("ask_user_question")) {
      pi.setActiveTools(active.filter((name) => name !== "ask_user_question"));
    }
  });

  pi.registerTool({
    name: "ask_user_question",
    label: "Ask User",
    description:
      "Pause and ask the user 1-4 multiple-choice questions when a real decision is required. Free-form answers are allowed by default. Do not use this for information you can find yourself.",
    promptSnippet: "Ask the user a structured question instead of guessing",
    promptGuidelines: [
      "Use ask_user_question when a genuine user decision is required and guessing would be expensive to undo.",
      "Do not use ask_user_question for facts you can inspect in the repo or look up with web_search.",
    ],
    parameters: Type.Object({
      questions: Type.Array(QuestionSchema, { description: `1-${MAX_QUESTIONS} questions` }),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const questions = params.questions as QuestionSpec[];
      const invalid = validateQuestions(questions);
      if (invalid) toolFailure(invalid, "QUESTION_INVALID");
      if (!ctx.hasUI) {
        toolFailure("Cannot ask the user in non-interactive mode; decide yourself and state the assumption.", "QUESTION_NO_UI");
      }
      if (signal?.aborted) toolFailure("Cancelled before the question was shown.", "QUESTION_CANCELLED");

      try {
        const result = await askQuestions(ctx, questions, signal);
        return toolText(formatAnswers(result.answers, result.cancelled), {
          answers: result.answers,
          cancelled: result.cancelled,
        });
      } catch (error) {
        toolFailure(`Could not ask the user: ${errorMessage(error)}`, "QUESTION_FAILED");
      }
    },
    renderCall: renderAskCall,
    renderResult: renderAskResult,
  });
}
