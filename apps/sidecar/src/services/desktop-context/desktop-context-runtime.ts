import type { DesktopAssistantSettings } from "@lume/shared";
import {
  getDesktopContextDbPath,
  getDesktopContextSettingsPath,
} from "../infra/config-paths";
import { invokeDesktopHost } from "./desktop-host-runtime";
import { DesktopContextService } from "./desktop-context-service";
import {
  loadDesktopAssistantSettings,
  saveDesktopAssistantSettings,
} from "./desktop-context-settings";

let runtime: { settingsPath: string; service: DesktopContextService } | null = null;

function getRuntime(): { settingsPath: string; service: DesktopContextService } {
  if (runtime) return runtime;
  const settingsPath = getDesktopContextSettingsPath();
  runtime = {
    settingsPath,
    service: new DesktopContextService({
      dbPath: getDesktopContextDbPath(),
      settings: loadDesktopAssistantSettings(settingsPath),
      invokeHost: invokeDesktopHost,
    }),
  };
  return runtime;
}

export const desktopContextRpcService = {
  unlock(key: Buffer): void {
    getRuntime().service.unlock(key);
  },
  captureCurrent(): Promise<unknown> {
    return getRuntime().service.captureCurrent();
  },
  currentContext(input?: { snapshotId?: string }): Promise<unknown> {
    return getRuntime().service.currentContext(input);
  },
  searchContext(input: { query?: string; limit?: number }): Promise<unknown> {
    return getRuntime().service.searchContext(input);
  },
  getSettings(): DesktopAssistantSettings {
    return getRuntime().service.getSettings();
  },
  updateSettings(settings: DesktopAssistantSettings): DesktopAssistantSettings {
    const current = getRuntime();
    const saved = saveDesktopAssistantSettings(current.settingsPath, settings);
    current.service.updateSettings(saved);
    return saved;
  },
  getStatus(): Promise<unknown> {
    return getRuntime().service.getStatus();
  },
  clear(): { cleared: boolean } {
    return getRuntime().service.clear();
  },
  listActivity(limit?: number) {
    return getRuntime().service.listActivity(limit);
  },
};

export async function invokeComputerUse(method: string, input: Record<string, unknown>): Promise<unknown> {
  if (method === "current_context") {
    return desktopContextRpcService.currentContext({
      ...(typeof input.snapshotId === "string" ? { snapshotId: input.snapshotId } : {}),
    });
  }
  if (method === "search_context") {
    return desktopContextRpcService.searchContext({
      ...(typeof input.query === "string" ? { query: input.query } : {}),
      ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
    });
  }
  return invokeDesktopHost(method, input);
}

export async function resolveDesktopContextProjection(
  messageMetadata: Record<string, unknown> | undefined,
  service: Pick<typeof desktopContextRpcService, "currentContext"> = desktopContextRpcService,
): Promise<unknown | undefined> {
  const snapshotId = messageMetadata?.desktopContextSnapshotId;
  if (typeof snapshotId !== "string" || !snapshotId.trim()) return undefined;

  const result = asRecord(await service.currentContext({ snapshotId }));
  return result.status === "ok" && result.snapshot
    ? { snapshot: result.snapshot }
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
