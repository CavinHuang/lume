import type { DesktopAssistantSettings, DesktopContextSuspensionReason } from "@lume/shared";
import { getOutboundNotificationWriter } from "../infra/outbound-notification";
import {
  getDesktopContextDbPath,
  getDesktopContextSettingsPath,
} from "../infra/config-paths";
import { invokeDesktopHost } from "./desktop-host-runtime";
import { DesktopContextService } from "./desktop-context-service";
import { createDesktopProposalResultGenerator } from "./desktop-proposal-generator";
import {
  loadDesktopAssistantSettings,
  saveDesktopAssistantSettings,
} from "./desktop-context-settings";

let runtime: { settingsPath: string; service: DesktopContextService } | null = null;
let hostNotificationsRegistered = false;

function getRuntime(): { settingsPath: string; service: DesktopContextService } {
  if (runtime) return runtime;
  const settingsPath = getDesktopContextSettingsPath();
  runtime = {
    settingsPath,
    service: new DesktopContextService({
      dbPath: getDesktopContextDbPath(),
      settings: loadDesktopAssistantSettings(settingsPath),
      invokeHost: (method, input) => invokeDesktopHost(`desktop_context.${method}`, input),
      manageHostEventSubscription: true,
      // #580:经 outbound-notification 单点读取出站写入器(组合根注入)
      emitNotification: (method, params) => getOutboundNotificationWriter()?.(method, params),
      generateProposalResult: createDesktopProposalResultGenerator(),
    }),
  };
  if (!hostNotificationsRegistered) {
    hostNotificationsRegistered = true;
    invokeDesktopHost.onNotification((method, params) => {
      runtime?.service.handleHostNotification(method, params);
    });
  }
  return runtime;
}

export const desktopContextRpcService = {
  unlock(key: Buffer): void {
    getRuntime().service.unlock(key);
  },
  setSuspended(reason: DesktopContextSuspensionReason, suspended: boolean) {
    return getRuntime().service.setSuspended(reason, suspended);
  },
  captureCurrent(input?: { userInitiated?: boolean }): Promise<unknown> {
    return getRuntime().service.captureCurrent(input);
  },
  getForegroundTarget(): Promise<unknown> {
    return getRuntime().service.getForegroundTarget();
  },
  listApps(): Promise<unknown> {
    return getRuntime().service.listApps();
  },
  captureWindow(input: { windowId?: string; userInitiated?: boolean }): Promise<unknown> {
    return getRuntime().service.captureWindow(input);
  },
  requestPermissions(): Promise<unknown> {
    return getRuntime().service.requestPermissions();
  },
  currentContext(input?: { snapshotId?: string; includeScreenshot?: boolean; refresh?: boolean }): Promise<unknown> {
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
  listProposals() {
    return getRuntime().service.listProposals();
  },
  updateProposal(id: string, status: Parameters<DesktopContextService["updateProposal"]>[1]) {
    return getRuntime().service.updateProposal(id, status);
  },
};

export async function invokeComputerUse(method: string, input: Record<string, unknown>): Promise<unknown> {
  if (method === "current_context") {
    return desktopContextRpcService.currentContext({
      ...(typeof input.snapshotId === "string" ? { snapshotId: input.snapshotId } : {}),
      ...(input.includeScreenshot === true ? { includeScreenshot: true } : {}),
      ...(input.refresh === true ? { refresh: true } : {}),
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
  invoke: (method: string, input: Record<string, unknown>) => Promise<unknown> = invokeComputerUse,
): Promise<unknown | undefined> {
  if (!messageMetadata) return undefined;
  const snapshotId = messageMetadata.desktopContextSnapshotId;
  if (typeof snapshotId !== "string" || !snapshotId.trim()) return undefined;

  const result = asRecord(await service.currentContext({ snapshotId }));
  if (result.status === "ok" && result.snapshot) {
    return stripDesktopContextImages(result.snapshot);
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stripDesktopContextImages(snapshot: unknown): { snapshot: unknown } {
  const value = asRecord(snapshot);
  if (!Object.keys(value).length) return { snapshot };
  return { snapshot: sanitizeSnapshotImages(value) };
}

function sanitizeSnapshotImages(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSnapshotImages(item));
  }
  const record = asRecord(value);
  if (!Object.keys(record).length) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === "screenshots" && Array.isArray(item)) {
      output[key] = item.map((candidate) => {
        const screenshot = asRecord(candidate);
        const { dataUrl: _dataUrl, ...metadata } = screenshot;
        return metadata;
      });
      continue;
    }
    output[key] = sanitizeSnapshotImages(item);
  }
  return output;
}
