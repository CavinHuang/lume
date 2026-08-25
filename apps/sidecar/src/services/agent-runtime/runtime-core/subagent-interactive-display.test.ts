import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getSubagentRunRegistry, resetSubagentRunRegistryForTest } from "../subagents/subagent-run-registry";
import { resolveSubagentInteractiveLabel } from "./subagent-interactive-display";

describe("resolveSubagentInteractiveLabel", () => {
  const prevConfigDir = process.env.LUME_CONFIG_DIR;

  afterEach(() => {
    resetSubagentRunRegistryForTest();
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
  });

  test("应优先使用 subagent 任务 label 作为展示名", () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-subagent-display-label-"));
    process.env.LUME_CONFIG_DIR = configDir;

    getSubagentRunRegistry().create({
      runId: "run-label",
      parentThreadId: "parent-thread",
      childThreadId: "child-thread",
      task: "task",
      label: "探索工具能力边界",
      requestedAgentId: "Explore",
      resolvedAgentId: "Explore",
      cleanup: "keep",
      status: "running"
    });

    expect(resolveSubagentInteractiveLabel("run-label")).toBe("探索工具能力边界");

    rmSync(configDir, { recursive: true, force: true });
  });

  test("缺少 label 时应退回 agent 名称", () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-subagent-display-agent-"));
    process.env.LUME_CONFIG_DIR = configDir;

    getSubagentRunRegistry().create({
      runId: "run-agent",
      parentThreadId: "parent-thread",
      childThreadId: "child-thread",
      task: "task",
      requestedAgentId: "Plan",
      resolvedAgentId: "Plan",
      cleanup: "keep",
      status: "running"
    });

    expect(resolveSubagentInteractiveLabel("run-agent")).toBe("Plan");

    rmSync(configDir, { recursive: true, force: true });
  });
});
