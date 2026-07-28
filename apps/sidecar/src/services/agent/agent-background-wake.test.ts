import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@lume/shared";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentBackgroundWakeController,
  isTerminalBackgroundTaskNotification
} from "./agent-background-wake";

function notification(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: "task-1",
    status: "completed",
    session_id: "thread-1",
    ...overrides
  } as SDKMessage;
}

describe("AgentBackgroundWakeController", () => {
  test("只接受当前主线程的终态任务通知", () => {
    expect(isTerminalBackgroundTaskNotification(notification(), "thread-1")).toBe(true);
    expect(isTerminalBackgroundTaskNotification(notification({ status: "running" }), "thread-1")).toBe(false);
    expect(isTerminalBackgroundTaskNotification(notification({ session_id: "thread-2" }), "thread-1")).toBe(false);
    expect(isTerminalBackgroundTaskNotification(notification({ subagent_run_id: "child-1" }), "thread-1")).toBe(false);
    expect(isTerminalBackgroundTaskNotification(notification(), "thread-1", "subagent")).toBe(false);
  });

  test("同一线程同一任务只唤醒一次，并允许不同任务继续唤醒", () => {
    const controller = new AgentBackgroundWakeController();
    expect(controller.tryClaim("thread-1", notification())).toBe(true);
    expect(controller.tryClaim("thread-1", notification())).toBe(false);
    expect(controller.tryClaim("thread-1", notification({ task_id: "task-2" }))).toBe(true);

    controller.release("thread-1", "task-1");
    expect(controller.tryClaim("thread-1", notification())).toBe(true);
  });

  test("重启后的 controller 不能重复消费持久化终态通知", () => {
    const root = mkdtempSync(join(tmpdir(), "lume-background-wake-"));
    const jobDir = join(root, "process-jobs", "task-1");
    mkdirSync(jobDir, { recursive: true });
    const outputFile = join(jobDir, "output.log");
    writeFileSync(outputFile, "done");
    writeFileSync(join(jobDir, "state.json"), JSON.stringify({
      version: 2,
      id: "task-1",
      status: "completed"
    }));
    const message = notification({ output_file: outputFile });

    expect(new AgentBackgroundWakeController().tryClaim("thread-1", message)).toBeTrue();
    expect(new AgentBackgroundWakeController().tryClaim("thread-1", message)).toBeFalse();
    expect(JSON.parse(readFileSync(join(jobDir, "state.json"), "utf8")).continuationConsumedAt).toBeNumber();
  });
});
