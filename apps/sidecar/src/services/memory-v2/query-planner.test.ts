import { describe, expect, test } from "bun:test";
import { createMemoryV2QueryPlanner } from "./query-planner";

describe("createMemoryV2QueryPlanner", () => {
  test("uses a configured chat model to plan structured claim recall", async () => {
    const calls: Array<{ system: string; userContent: string }> = [];
    const planner = createMemoryV2QueryPlanner({
      workspaceSlug: "demo",
      modelRef: "openai/gpt-5-mini",
      createProvider: () => ({
        apiType: "openai-completions",
        async createMessage(params) {
          calls.push({
            system: params.system,
            userContent: String(params.messages[0]?.content ?? "")
          });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                querySubject: "user/self",
                desiredPredicates: ["preference"],
                includeConversationHistory: false
              })
            }],
            stopReason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 }
          };
        }
      })
    });

    expect(planner).toBeDefined();
    const plan = await planner?.("收尾报告应该怎么写？");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.system).toContain("Plan Lume memory recall");
    expect(calls[0]?.userContent).toContain("收尾报告应该怎么写？");
    expect(plan).toEqual({
      querySubject: "user/self",
      desiredPredicates: ["preference"],
      includeConversationHistory: false
    });
  });
});
