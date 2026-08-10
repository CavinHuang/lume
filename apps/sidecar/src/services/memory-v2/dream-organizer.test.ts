import { describe, expect, test } from "bun:test";
import { hasStrongDreamEvidence } from "./dream-organizer";
import type { DreamEvidenceItem } from "./dream-evidence";

describe("Dream proposal evidence rules", () => {
  test("rejects Assistant-only support", () => {
    expect(hasStrongDreamEvidence(
      { content: "用户偏好默认中文回答", explicitUserStatement: true },
      [evidence("assistant_message", "run-1", "用户似乎偏好默认中文回答")]
    )).toBe(false);
  });

  test("accepts one explicit user statement with matching Chinese meaning tokens", () => {
    expect(hasStrongDreamEvidence(
      { content: "用户偏好默认中文回答", explicitUserStatement: true },
      [evidence("user_message", "run-1", "以后请默认使用中文回答")]
    )).toBe(true);
  });

  test("accepts independent user evidence from two runs", () => {
    expect(hasStrongDreamEvidence(
      { content: "用户喜欢简洁回答" },
      [
        evidence("user_message", "run-1", "回答简洁一点"),
        evidence("user_message", "run-2", "继续保持简短")
      ]
    )).toBe(true);
  });
});

function evidence(sourceType: DreamEvidenceItem["sourceType"], runId: string, text: string): DreamEvidenceItem {
  return { id: `${sourceType}:${runId}`, sourceType, runId, text };
}
