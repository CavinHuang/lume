import type { AgentAskUserQuestionRequest } from "@lume/shared";

export const ASK_USER_OTHER_OPTION = "__other__";

export function buildAskUserQuestionAnswers(
  request: AgentAskUserQuestionRequest,
  values: Record<string, { selected: string[]; otherText: string }>
): { answers: Record<string, string> } | { error: string } {
  const answers: Record<string, string> = {};

  for (const question of request.questions) {
    const value = values[question.header] ?? { selected: [], otherText: "" };
    const selectedLabels = value.selected.filter((item) => item !== ASK_USER_OTHER_OPTION);
    const otherText = value.otherText.trim();

    let answerText = "";
    if (question.multiSelect) {
      const merged = [...selectedLabels];
      if (value.selected.includes(ASK_USER_OTHER_OPTION) && otherText) {
        merged.push(otherText);
      }
      answerText = merged.join(", ").trim();
    } else {
      const first = value.selected[0];
      answerText = first === ASK_USER_OTHER_OPTION ? otherText : (first ?? "");
    }

    if (!answerText) {
      return { error: `请先回答「${question.header}」` };
    }

    answers[question.header] = answerText;
  }

  return { answers };
}
