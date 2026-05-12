import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();

function source(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("RuntimeEvent sidecar boundary", () => {
  test("agent RPC handlers no longer emit or hydrate legacy run events", () => {
    const content = source("apps/sidecar/src/rpc/agent-handlers.ts");

    expect(content).not.toContain("AGENT_IPC_CHANNELS.RUN_EVENT");
    expect(content).not.toContain("GET_THREAD_RUN_EVENTS");
    expect(content).not.toContain("projectRunStateToRunEvents");
    expect(content).not.toContain("projectTaskRunToProgressEvents");
    expect(content).not.toContain("projectTaskRunEventToProgressEvent");
    expect(content).not.toContain("projectRunStateToRuntimeEvents");
    expect(content).not.toContain("projectTaskRunToRuntimeEvents");
  });

  test("agent RPC handlers delegate task execution orchestration", () => {
    const content = source("apps/sidecar/src/rpc/agent-handlers.ts");

    expect(content).not.toContain("../services/agent-runtime/task-run/task-run-controller");
    expect(content).not.toContain("../services/agent-runtime/task-run/task-run-store");
    expect(content).not.toContain("buildCurrentTaskRunSendInput");
    expect(content).not.toContain("createTaskRunFromContract");
    expect(content).not.toContain("startNextTaskRunTask");
    expect(content).not.toContain("skipCurrentTask");
    expect(content).not.toContain("markCurrentTaskUnreported");
    expect(content).not.toContain("markTaskRunWaiting");
    expect(content).not.toContain("const dispatchTaskExecution");
    expect(content).not.toContain("function createTaskRunFromTaskContractRecord");
  });

  test("runtime runner path no longer exposes onRunEvent callbacks", () => {
    for (const file of [
      "apps/sidecar/src/services/pi-agent/runner/types.ts",
      "apps/sidecar/src/services/agent-runtime/runner/run-loop.ts",
      "apps/sidecar/src/services/agent-runtime/runner/run-observer.ts",
      "apps/sidecar/src/services/agent-runtime/runner/lume-runner.ts",
      "apps/sidecar/src/services/agent/agent-service.ts"
    ]) {
      expect(source(file)).not.toContain("onRunEvent");
    }
  });

  test("shared and sidecar event projection boundary exposes only RuntimeEvent", () => {
    for (const file of [
      "packages/shared/src/types/agent.ts",
      "apps/sidecar/src/services/agent-runtime/runner/run-item-events.ts",
      "apps/sidecar/src/services/agent-runtime/task-run/task-progress-events.ts"
    ]) {
      const content = source(file);

      expect(content).not.toContain("LumeRunEvent");
      expect(content).not.toContain("AgentRunEventNotification");
      expect(content).not.toContain("AgentThreadRunEventsResult");
      expect(content).not.toContain("GET_THREAD_RUN_EVENTS");
      expect(content).not.toContain("RUN_EVENT");
      expect(content).not.toContain("projectRunStateToRunEvents");
      expect(content).not.toContain("projectRunItemToRunEvent");
      expect(content).not.toContain("projectRunItemToRunEvents");
      expect(content).not.toContain("projectAssistantMessageFinalEvent");
      expect(content).not.toContain("projectTaskRunEventToProgressEvent");
      expect(content).not.toContain("projectTaskRunToProgressEvents");
    }
  });
});
