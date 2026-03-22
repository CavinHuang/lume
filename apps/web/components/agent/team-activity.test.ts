import { describe, expect, test } from "bun:test";
import type { AgentMessage, SubagentRunRecord } from "@lume/shared";
import { buildTeamActivitiesFromRuns, extractTeamInboxFromMessages } from "./team-activity";

describe("team-activity", () => {
  test("extractTeamInboxFromMessages 应提取并按时间倒序返回 announce 消息", () => {
    const messages: AgentMessage[] = [
      {
        id: "m1",
        role: "assistant",
        content: "子任务完成通知: A (completed)\nrunId: run-a",
        createdAt: 100,
        metadata: {
          subagentAnnounce: true,
          runId: "run-a",
          childSessionId: "child-a",
          status: "completed"
        }
      },
      {
        id: "m2",
        role: "assistant",
        content: "普通回复",
        createdAt: 120
      },
      {
        id: "m3",
        role: "assistant",
        content: "子任务完成通知: B (errored)\nrunId: run-b",
        createdAt: 110,
        metadata: {
          subagentAnnounce: true,
          runId: "run-b",
          childSessionId: "child-b",
          status: "errored"
        }
      }
    ];

    const inbox = extractTeamInboxFromMessages(messages);
    expect(inbox).toHaveLength(2);
    expect(inbox[0]?.messageId).toBe("m3");
    expect(inbox[1]?.messageId).toBe("m1");
    expect(inbox[0]?.isError).toBe(true);
    expect(inbox[1]?.isError).toBe(false);
  });

  test("buildTeamActivitiesFromRuns 应映射 run telemetry 字段", () => {
    const runs: SubagentRunRecord[] = [
      {
        runId: "run-1",
        parentSessionId: "parent-1",
        rootSessionId: "parent-1",
        depth: 1,
        childSessionId: "child-1",
        task: "do work",
        status: "completed",
        cleanup: "keep",
        announceStatus: "delivered",
        createdAt: 1,
        updatedAt: 2,
        startedAt: 1,
        endedAt: 2,
        outcome: {
          output: "ok",
          usageEvents: 3
        }
      }
    ];

    const activities = buildTeamActivitiesFromRuns(runs);
    expect(activities).toHaveLength(1);
    expect(activities[0]?.toolName).toBe("Agent");
    expect(activities[0]?.done).toBe(true);
    expect(activities[0]?.isError).toBe(false);
    expect(activities[0]?.input.run_id).toBe("run-1");
    expect(activities[0]?.input.usage_events).toBe(3);
    expect(activities[0]?.input.announce_status).toBe("delivered");
  });
});
