import { describe, expect, test } from "bun:test";
import { assertBridgeSmokeOutcome } from "./agent-runtime-bridges-smoke";

describe("agent-runtime-bridges-smoke helpers", () => {
  test("assertBridgeSmokeOutcome 应校验 permission / ask-user / subagent announce 全链路结果", () => {
    expect(() =>
      assertBridgeSmokeOutcome({
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
        messageAppendedEvent: {
          runId: "run-1"
        },
        messages: [
          {
            role: "assistant",
            metadata: {
              subagentAnnounce: true,
              runId: "run-1"
            }
          }
        ]
      })
    ).not.toThrow();
  });
});
