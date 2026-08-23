import { describe, expect, test } from "bun:test";
import { fromAgentRuntimeRunResult } from "./run-result";
import type { AgentRuntimeRunResult } from "./types";

describe("fromAgentRuntimeRunResult", () => {
  test("#392:repeat guard 收场(带标记 turn_limited)落 completed 而非 failed", () => {
    const result: AgentRuntimeRunResult = {
      status: "turn_limited",
      errorMessage: 'Agent stopped after retrying the unchanged "bash" call despite repeat-guard feedback.',
      terminationReason: "repeat_guard"
    };

    expect(fromAgentRuntimeRunResult(result)).toEqual({
      status: "completed",
      verificationStatus: undefined,
      codingReport: undefined
    });
  });

  test("泛化 errored 仍落 failed", () => {
    expect(fromAgentRuntimeRunResult({ status: "errored", errorMessage: "boom" })).toEqual({
      status: "failed",
      error: "boom",
      verificationStatus: undefined,
      codingReport: undefined
    });
  });
});
