import { MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS } from "../security/limits.ts";

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionSpec {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface QuestionAnswer {
  question: string;
  header?: string;
  selected: string[];
  custom?: string;
}

export function validateQuestions(questions: QuestionSpec[]): string | undefined {
  if (!Array.isArray(questions) || questions.length === 0) return "Provide at least one question.";
  if (questions.length > MAX_QUESTIONS) return `Ask at most ${MAX_QUESTIONS} questions at a time.`;
  for (const [index, question] of questions.entries()) {
    if (!question.question?.trim()) return `Question ${index + 1} is missing question text.`;
    if (!Array.isArray(question.options) || question.options.length < MIN_OPTIONS) {
      return `Question ${index + 1} needs at least ${MIN_OPTIONS} options.`;
    }
    if (question.options.length > MAX_OPTIONS) {
      return `Question ${index + 1} has more than ${MAX_OPTIONS} options.`;
    }
    for (const option of question.options) {
      if (!option.label?.trim()) return `Question ${index + 1} has an option with an empty label.`;
    }
  }
  return undefined;
}

export function formatAnswers(answers: QuestionAnswer[], cancelled: boolean): string {
  if (cancelled) return "User cancelled the questionnaire.";
  return answers
    .map((answer) => {
      const value = answer.custom
        ? `wrote: ${answer.custom}`
        : answer.selected.length > 0
          ? answer.selected.join(", ")
          : "(no answer)";
      return `Q: ${answer.question}\nA: ${value}`;
    })
    .join("\n\n");
}
