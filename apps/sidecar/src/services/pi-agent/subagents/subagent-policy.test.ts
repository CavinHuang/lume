import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { getSubagentRunRegistry, resetSubagentRunRegistryForTest } from "./subagent-run-registry";
import { resolveSubagentSpawnPolicy } from "./subagent-policy";

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

