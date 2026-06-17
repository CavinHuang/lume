import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_IPC_CHANNELS, type AgentListPluginsResult } from "@lume/shared";
import type { PlanModePhaseTracker } from "../services/agent/plan-mode-phase-tracker";
import { createAgentHandlers } from "./agent-handlers";

const previousHome = process.env.HOME;

describe("agent handlers LIST_PLUGINS", () => {
  afterEach(() => {
    if (process.env.HOME) {
      rmSync(process.env.HOME, { recursive: true, force: true });
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  });

  test("returns normalized plugin list result shape", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "lume-list-plugins-rpc-"));
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: {
        isLikelyExecutionRequest: () => false,
        getPhase: () => "idle",
        clearSession: () => undefined,
      } as unknown as PlanModePhaseTracker,
      notifyPlanModePhaseChange: () => undefined,
    });

    const result = await handlers[AGENT_IPC_CHANNELS.LIST_PLUGINS]!({}) as AgentListPluginsResult;

    expect(result).toHaveProperty("plugins");
    expect(result).toHaveProperty("diagnostics");
    expect(Array.isArray(result.plugins)).toBe(true);
    expect(Array.isArray(result.diagnostics)).toBe(true);
  });
});
