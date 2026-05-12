import { describe, expect, test } from "bun:test";
import { assertInteractionSmokeOutcome } from "./agent-runtime-interactions-smoke";

describe("agent-runtime-interactions-smoke helpers", () => {
  test("assertInteractionSmokeOutcome 应校验 permission / ask-user / subagent completed 全链路结果", () => {
    expect(() =>
      assertInteractionSmokeOutcome({
        permissionRequest: { requestId: "perm-1", toolName: "write" },
        askUserRequest: { toolUseId: "ask-1", questions: [{ header: "范围" }] },
        statusPhases: ["awaiting_permission", "awaiting_user_answer", "completed"],
        restoredRuntimeStatus: { phase: "idle" },
        listSubagentRuns: {
          runs: [
            {
              runId: "run-1",
              status: "completed",
              announceStatus: "delivered"
            }
          ]
        },
        restoredSubagentRuns: {
          runs: [
            {
              runId: "run-1",
              status: "completed"
            }
          ]
        },
        subagentCompletedEvent: {
          runId: "run-1"
        },
        messages: []
      })
    ).not.toThrow();
  });
});
