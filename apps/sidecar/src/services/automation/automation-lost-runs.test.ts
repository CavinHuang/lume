import { describe, expect, test } from "bun:test";
import {
  MAX_LOST_RUNS,
  clearLostAutomationRunsForTests,
  getLostAutomationRuns,
  recordLostAutomationRun
} from "./automation-lost-runs";

describe("automation-lost-runs（#615 影子记录）", () => {
  test("记录带 persistenceLost 标记，超过上限淘汰最旧", () => {
    clearLostAutomationRunsForTests();
    for (let i = 0; i < MAX_LOST_RUNS + 5; i += 1) {
      recordLostAutomationRun({
        id: `run-${i}`,
        jobId: "job-lost",
        jobName: "任务",
        trigger: "schedule",
        status: "success",
        message: "",
        startedAt: i,
        finishedAt: i
      });
    }
    const lost = getLostAutomationRuns();
    expect(lost.length).toBe(MAX_LOST_RUNS);
    // 最旧的 run-0..4 被淘汰，保留 run-5 起
    expect(lost[0]?.id).toBe("run-5");
    expect(lost.every((run) => run.persistenceLost === true)).toBeTrue();
    clearLostAutomationRunsForTests();
    expect(getLostAutomationRuns().length).toBe(0);
  });
});
