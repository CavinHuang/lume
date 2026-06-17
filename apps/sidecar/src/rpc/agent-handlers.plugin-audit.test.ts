import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_IPC_CHANNELS, type GetPluginAuditLogResult } from "@lume/shared";
import type { PlanModePhaseTracker } from "../services/agent/plan-mode-phase-tracker";
import { createAgentHandlers } from "./agent-handlers";
import { appendPluginAuditEntry } from "../services/agent-runtime/plugins/plugin-audit-store";
import { getPluginAuditPath } from "../services/infra/config-paths";

const previousConfigDir = process.env.LUME_CONFIG_DIR;

describe("agent handlers GET_PLUGIN_AUDIT_LOG", () => {
  afterEach(() => {
    if (process.env.LUME_CONFIG_DIR) {
      rmSync(process.env.LUME_CONFIG_DIR, { recursive: true, force: true });
    }
    if (previousConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previousConfigDir;
    }
  });

  function buildHandlers() {
    return createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: {
        isLikelyExecutionRequest: () => false,
        getPhase: () => "idle",
        clearSession: () => undefined,
      } as unknown as PlanModePhaseTracker,
      notifyPlanModePhaseChange: () => undefined,
    });
  }

  // getConfigDir() reads LUME_CONFIG_DIR first (absolute path → used as-is),
  // so pointing it at a temp dir isolates getPluginAuditPath() away from the
  // real ~/.lume. (homedir() does not reliably honor a runtime HOME override
  // for write paths, so we use LUME_CONFIG_DIR instead.)
  function isolateConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "lume-plugin-audit-rpc-"));
    process.env.LUME_CONFIG_DIR = dir;
    return dir;
  }

  test("returns events filtered by pluginId from the audit store", async () => {
    isolateConfigDir();
    // Seed the default audit path with events for two plugins.
    const path = getPluginAuditPath();
    await appendPluginAuditEntry(path, {
      id: "a1",
      pluginId: "acme",
      type: "sensitive_approval",
      createdAt: "t1",
      summary: "ok",
    });
    await appendPluginAuditEntry(path, {
      id: "b1",
      pluginId: "beta",
      type: "sensitive_denial",
      createdAt: "t2",
      summary: "no",
    });
    await appendPluginAuditEntry(path, {
      id: "a2",
      pluginId: "acme",
      type: "capability_blocked",
      createdAt: "t3",
      summary: "blocked",
    });

    const handlers = buildHandlers();
    const result = (await handlers[AGENT_IPC_CHANNELS.GET_PLUGIN_AUDIT_LOG]!({
      pluginId: "acme",
    })) as GetPluginAuditLogResult;

    expect(result.events).toHaveLength(2);
    expect(result.events.map((e) => e.id)).toEqual(["a1", "a2"]);
    expect(result.events.every((e) => e.pluginId === "acme")).toBe(true);
  });

  test("honors limit (tails most recent)", async () => {
    isolateConfigDir();
    const path = getPluginAuditPath();
    await appendPluginAuditEntry(path, {
      id: "1",
      pluginId: "acme",
      type: "needs_review",
      createdAt: "t1",
      summary: "x",
    });
    await appendPluginAuditEntry(path, {
      id: "2",
      pluginId: "acme",
      type: "needs_review",
      createdAt: "t2",
      summary: "y",
    });

    const handlers = buildHandlers();
    const result = (await handlers[AGENT_IPC_CHANNELS.GET_PLUGIN_AUDIT_LOG]!({
      pluginId: "acme",
      limit: 1,
    })) as GetPluginAuditLogResult;

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.id).toBe("2");
  });

  test("filters by workspaceSlug within the same pluginId", async () => {
    isolateConfigDir();
    const path = getPluginAuditPath();
    await appendPluginAuditEntry(path, {
      id: "a1",
      pluginId: "acme",
      workspaceSlug: "ws-a",
      type: "sensitive_approval",
      createdAt: "t1",
      summary: "ok",
    });
    await appendPluginAuditEntry(path, {
      id: "a2",
      pluginId: "acme",
      workspaceSlug: "ws-b",
      type: "sensitive_denial",
      createdAt: "t2",
      summary: "no",
    });
    await appendPluginAuditEntry(path, {
      id: "a3",
      pluginId: "acme",
      workspaceSlug: "ws-a",
      type: "capability_blocked",
      createdAt: "t3",
      summary: "blocked",
    });

    const handlers = buildHandlers();
    const result = (await handlers[AGENT_IPC_CHANNELS.GET_PLUGIN_AUDIT_LOG]!({
      pluginId: "acme",
      workspaceSlug: "ws-a",
    })) as GetPluginAuditLogResult;

    expect(result.events).toHaveLength(2);
    expect(result.events.map((e) => e.id)).toEqual(["a1", "a3"]);
    expect(result.events.every((e) => e.workspaceSlug === "ws-a")).toBe(true);
  });
});
