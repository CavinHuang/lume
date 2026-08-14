import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AGENT_IPC_CHANNELS, type GetMarketCatalogResult, type InspectPluginResult } from "@lume/shared";
import type { PlanModePhaseTracker } from "../services/agent/plan-mode-phase-tracker";
import { createAgentHandlers } from "./agent-handlers";

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf-8");
}

const previousHome = process.env.HOME;
const previousConfigDir = process.env.LUME_CONFIG_DIR;

function makeHandlers(notifications: string[] = []) {
  return createAgentHandlers({
    writeNotification: (channel) => {
      notifications.push(channel);
    },
    planModePhaseTracker: {
      getPhase: () => "idle",
      clearSession: () => undefined,
    } as unknown as PlanModePhaseTracker,
    notifyPlanModePhaseChange: () => undefined,
  });
}

describe("agent handlers plugin market", () => {
  afterEach(() => {
    if (process.env.HOME) rmSync(process.env.HOME, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = previousConfigDir;
  });

  test("GET_MARKET_CATALOG returns unified result shape", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "lume-market-rpc-"));
    process.env.LUME_CONFIG_DIR = join(process.env.HOME, "config");
    const handlers = makeHandlers();

    const result = await handlers[AGENT_IPC_CHANNELS.GET_MARKET_CATALOG]!({
      workspaceSlug: "default"
    }) as GetMarketCatalogResult;

    expect(Array.isArray(result.plugins)).toBe(true);
    expect(Array.isArray(result.skills)).toBe(true);
    expect(Array.isArray(result.diagnostics)).toBe(true);
  });

  test("INSPECT_MARKET_SOURCE inspects local plugin sources", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "lume-market-rpc-"));
    process.env.LUME_CONFIG_DIR = join(process.env.HOME, "config");
    const pluginRoot = join(process.env.HOME, "plugin");
    await writeJson(join(pluginRoot, "lume-plugin.json"), {
      schema: "lume-plugin/v1",
      name: "rpc-plugin",
      version: "1.0.0"
    });
    const handlers = makeHandlers();

    const result = await handlers[AGENT_IPC_CHANNELS.INSPECT_MARKET_SOURCE]!({
      workspaceSlug: "default",
      source: { type: "local", path: pluginRoot }
    }) as InspectPluginResult;

    expect(result.kind).toBe("plugin");
    expect(result.normalized.pluginId).toBe("rpc-plugin");
    expect(result.permissionsHash).toHaveLength(64);
  });

  test("RELOAD_PLUGINS still emits capabilities changed notification", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "lume-market-rpc-"));
    process.env.LUME_CONFIG_DIR = join(process.env.HOME, "config");
    const notifications: string[] = [];
    const handlers = makeHandlers(notifications);

    await handlers[AGENT_IPC_CHANNELS.RELOAD_PLUGINS]!({});

    expect(notifications).toContain(AGENT_IPC_CHANNELS.CAPABILITIES_CHANGED);
  });
});
