import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { getSubagentRunRegistry, resetSubagentRunRegistryForTest } from "./subagent-run-registry";
import { clampSubagentPermissionMode, resolveSubagentSpawnPolicy } from "./subagent-policy";

let previousConfigDir: string | undefined;
let previousMaxDepth: string | undefined;
let previousMaxFanout: string | undefined;

beforeEach(() => {
  previousConfigDir = process.env.LUME_CONFIG_DIR;
  previousMaxDepth = process.env.LUME_SUBAGENT_MAX_DEPTH;
  previousMaxFanout = process.env.LUME_SUBAGENT_MAX_FANOUT;
  process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-subagent-policy-"));
  delete process.env.LUME_SUBAGENT_MAX_DEPTH;
  delete process.env.LUME_SUBAGENT_MAX_FANOUT;
  resetSubagentRunRegistryForTest();
});

afterEach(() => {
  if (previousConfigDir === undefined) {
    delete process.env.LUME_CONFIG_DIR;
  } else {
    process.env.LUME_CONFIG_DIR = previousConfigDir;
  }
  if (previousMaxDepth === undefined) {
    delete process.env.LUME_SUBAGENT_MAX_DEPTH;
  } else {
    process.env.LUME_SUBAGENT_MAX_DEPTH = previousMaxDepth;
  }
  if (previousMaxFanout === undefined) {
    delete process.env.LUME_SUBAGENT_MAX_FANOUT;
  } else {
    process.env.LUME_SUBAGENT_MAX_FANOUT = previousMaxFanout;
  }
  resetSubagentRunRegistryForTest();
});

describe("subagent-policy", () => {
  test("应拒绝超过最大深度的 spawn", () => {
    process.env.LUME_SUBAGENT_MAX_DEPTH = "1";
    const registry = getSubagentRunRegistry();
    registry.create({
      runId: randomUUID(),
      parentThreadId: "session-root",
      childThreadId: "session-child",
      rootThreadId: "session-root",
      depth: 1,
      task: "parent task",
      cleanup: "keep",
      status: "running"
    });
    const decision = resolveSubagentSpawnPolicy({
      parentThreadId: "session-child"
    });
    expect(decision.ok).toBe(false);
    expect(decision.error).toContain("深度超限");
  });

  test("应拒绝超过扇出限制的 spawn", () => {
    process.env.LUME_SUBAGENT_MAX_FANOUT = "1";
    const registry = getSubagentRunRegistry();
    registry.create({
      runId: randomUUID(),
      parentThreadId: "session-main",
      childThreadId: "session-child-1",
      task: "active child",
      cleanup: "keep",
      status: "running"
    });
    const decision = resolveSubagentSpawnPolicy({
      parentThreadId: "session-main"
    });
    expect(decision.ok).toBe(false);
    expect(decision.error).toContain("扇出超限");
  });

  test("sandbox=require 时应继承父会话 permission mode", () => {
    const decision = resolveSubagentSpawnPolicy({
      parentThreadId: "session-main",
      parentPermissionMode: "plan",
      requestedSandbox: "require"
    });
    expect(decision.ok).toBe(true);
    expect(decision.childPermissionMode).toBe("plan");
  });
});

describe("clampSubagentPermissionMode", () => {
  test("未请求时应继承父级模式（含 undefined 父级）", () => {
    expect(clampSubagentPermissionMode(undefined, "default")).toBe("default");
    expect(clampSubagentPermissionMode(undefined, undefined)).toBeUndefined();
  });

  test("default 父级下请求 bypassPermissions 应钳制为 default", () => {
    expect(clampSubagentPermissionMode("bypassPermissions", "default")).toBe("default");
  });

  test("dontAsk 父级下请求 dontAsk/auto/acceptEdits 应放行（同级或降级请求）", () => {
    expect(clampSubagentPermissionMode("dontAsk", "dontAsk")).toBe("dontAsk");
    expect(clampSubagentPermissionMode("auto", "dontAsk")).toBe("dontAsk");
    expect(clampSubagentPermissionMode("acceptEdits", "dontAsk")).toBe("acceptEdits");
  });

  test("default 父级下请求 auto 应钳制（auto 档位高于 default）", () => {
    expect(clampSubagentPermissionMode("auto", "default")).toBe("default");
  });

  test("bypassPermissions 父级下应放行全部请求", () => {
    expect(clampSubagentPermissionMode("bypassPermissions", "bypassPermissions")).toBe("bypassPermissions");
    expect(clampSubagentPermissionMode("default", "bypassPermissions")).toBe("default");
  });

  test("plan 与 default 同档：plan 父级可派生 default 子级", () => {
    expect(clampSubagentPermissionMode("default", "plan")).toBe("default");
    expect(clampSubagentPermissionMode("plan", "default")).toBe("plan");
  });

  test("未知模式应继承父级", () => {
    expect(clampSubagentPermissionMode("yolo", "acceptEdits")).toBe("acceptEdits");
    expect(clampSubagentPermissionMode("yolo", undefined)).toBeUndefined();
  });
});

