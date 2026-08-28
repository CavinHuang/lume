import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 仓库根从测试文件位置推导：process.cwd() 在 bun 全量/子目录跑批下不等于仓库根，
// 相对路径读源码会 ENOENT（基线池 A 根因）
const repoRoot = join(import.meta.dir, "../../../..");

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

  test("runtime runner path no longer exposes onRunEvent callbacks", () => {
    for (const file of [
      "apps/sidecar/src/services/agent-runtime/runtime-core/types.ts",
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
      "apps/sidecar/src/services/agent-runtime/runtime-core/run-item-events.ts"
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
