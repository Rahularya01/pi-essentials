import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  failLine,
  firstText,
  GLYPH,
  meta,
  okLine,
  oneLine,
  safeRender,
  titleLine,
  type RenderableResult,
  type RenderSlot,
} from "../ui/render.ts";
import type { QuestionAnswer, QuestionSpec } from "./validate.ts";

interface AskDetails {
  answers?: QuestionAnswer[];
  cancelled?: boolean;
}

export function renderAskCall(args: { questions?: QuestionSpec[] }, theme: Theme, context: RenderSlot): Text {
  return safeRender(
    () => {
      const questions = args?.questions ?? [];
      const first = questions[0]?.question;
      return (
        titleLine(theme, "ask_user_question", first ? oneLine(first, 56) : undefined) +
        meta(theme, [questions.length > 1 ? `${questions.length} questions` : undefined])
      );
    },
    "ask_user_question",
    context,
  );
}

export function renderAskResult(
  result: RenderableResult<AskDetails | undefined>,
  _options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: RenderSlot,
): Text {
  return safeRender(
    () => {
      if (context.isError) return failLine(theme, oneLine(firstText(result) || "could not ask", 96));

      const details = result?.details ?? {};
      const answers = details.answers ?? [];
      if (details.cancelled && answers.length === 0) {
        return `${theme.fg("warning", GLYPH.pending)} ${theme.fg("muted", "cancelled")}`;
      }

      // The answer is the point, so it is always shown in full.
      let out = okLine(theme, theme.fg("text", `${answers.length} answered`));
      for (const answer of answers) {
        const label = answer.header?.trim() ? theme.fg("muted", `[${answer.header.trim()}] `) : "";
        const picked = [answer.selected.join(", "), answer.custom && `"${answer.custom}"`]
          .filter((part): part is string => Boolean(part))
          .join(" | ");
        out += `\n  ${label}${theme.fg("dim", oneLine(answer.question, 52))}`;
        out += `\n    ${theme.fg("accent", GLYPH.arrow)} ${theme.fg("text", oneLine(picked || "(no answer)", 60))}`;
      }
      if (details.cancelled) out += theme.fg("warning", `\n  ${GLYPH.sep} remaining questions cancelled`);
      return out;
    },
    oneLine(firstText(result), 120),
    context,
  );
}
