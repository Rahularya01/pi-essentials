import { MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS } from "../security/limits.ts";

export interface QuestionOption {
  label: string;
  description?: string;
  value?: string;
}

export interface QuestionSpec {
  id?: string;
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
  /** OMP-compatible alias for multiSelect. */
  multiple?: boolean;
  recommended?: number;
  allowOther?: boolean;
}

export interface QuestionAnswer {
  id?: string;
  question: string;
  header?: string;
  selected: string[];
  selectedValues?: string[];
  selectedIndices?: number[];
  custom?: string;
}

export function isMultiple(question: QuestionSpec): boolean {
  return question.multiple ?? question.multiSelect ?? false;
}

export function validateQuestions(questions: QuestionSpec[]): string | undefined {
  if (!Array.isArray(questions) || questions.length === 0) return "Provide at least one question.";
  if (questions.length > MAX_QUESTIONS) return `Ask at most ${MAX_QUESTIONS} questions at a time.`;
  for (const [index, question] of questions.entries()) {
    const label = `Question ${index + 1}`;
    if (!question?.question?.trim()) return `${label} is missing question text.`;
    if (question.id !== undefined && (typeof question.id !== "string" || !question.id.trim())) {
      return `${label} id must be a non-empty string.`;
    }
    if (question.multiple !== undefined && question.multiSelect !== undefined && question.multiple !== question.multiSelect) {
      return `${label} has conflicting multiple and multiSelect values.`;
    }
    if (!Array.isArray(question.options) || question.options.length < MIN_OPTIONS) {
      return `${label} needs at least ${MIN_OPTIONS} options.`;
    }
    if (question.options.length > MAX_OPTIONS) {
      return `${label} has more than ${MAX_OPTIONS} options.`;
    }
    if (
      question.recommended !== undefined &&
      (!Number.isInteger(question.recommended) || question.recommended < 0 || question.recommended >= question.options.length)
    ) {
      return `${label} recommended must be a valid zero-based option index.`;
    }
    const seen = new Set<string>();
    for (const option of question.options) {
      const text = option?.label?.trim();
      if (!text) return `${label} has an option with an empty label.`;
      if (option.value !== undefined && typeof option.value !== "string") return `${label} has an option with an invalid value.`;
      const key = text.toLowerCase();
      if (seen.has(key)) return `${label} repeats the option "${text}"; options must be distinct.`;
      seen.add(key);
    }
  }
  return undefined;
}

/** Render answers for the transcript and for the model's next turn. */
export function formatAnswers(answers: QuestionAnswer[], cancelled: boolean): string {
  if (cancelled && answers.length === 0) return "User cancelled the questionnaire.";
  const body = answers
    .map((answer) => {
      const parts: string[] = [];
      if (answer.selected.length > 0) parts.push(answer.selected.join(", "));
      if (answer.custom) parts.push(`wrote: ${answer.custom}`);
      const prefix = answer.header?.trim() ? `[${answer.header.trim()}] ` : "";
      return `Q: ${prefix}${answer.question}\nA: ${parts.length > 0 ? parts.join(" | ") : "(no answer)"}`;
    })
    .join("\n\n");
  return cancelled ? `${body}\n\nUser cancelled the remaining questions.` : body;
}
