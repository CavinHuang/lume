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
let notificationWriter: ((method: string, params: unknown) => void) | undefined;

function getRuntime(): { settingsPath: string; service: DesktopContextService } {
  if (runtime) return runtime;
  const settingsPath = getDesktopContextSettingsPath();
  runtime = {
    settingsPath,
    service: new DesktopContextService({
      dbPath: getDesktopContextDbPath(),
      settings: loadDesktopAssistantSettings(settingsPath),
      invokeHost: invokeDesktopHost,
      emitNotification: (method, params) => notificationWriter?.(method, params),
    }),
  };
  return runtime;
}

export function setDesktopContextNotificationWriter(writer: (method: string, params: unknown) => void): void {
  notificationWriter = writer;
}

export const desktopContextRpcService = {
  unlock(key: Buffer): void {
    getRuntime().service.unlock(key);
  },
  captureCurrent(input?: { userInitiated?: boolean }): Promise<unknown> {
    return getRuntime().service.captureCurrent(input);
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

  const result = asRecord(await service.currentContext({ snapshotId, includeScreenshot: true }));
  if (result.status === "ok" && result.snapshot) {
    return splitDesktopContextImages(result.snapshot);
  }

  const desktopWindow = asRecord(messageMetadata?.desktopWindow);
  const windowId = stringValue(desktopWindow.id);
  if (!windowId) return undefined;
  const state = asRecord(await invoke("get_window_state", { windowId, includeScreenshot: true }));
  if (state.status !== "ok") return undefined;
  return splitDesktopContextImages(snapshotFromWindowState(snapshotId, messageMetadata, state));
}

function snapshotFromWindowState(
  snapshotId: string,
  messageMetadata: Record<string, unknown>,
  state: Record<string, unknown>,
): Record<string, unknown> {
  const app = asRecord(messageMetadata.desktopApp);
  const window = asRecord(state.window);
  const accessibility = asRecord(state.accessibility);
  return {
    id: snapshotId,
    app: {
      id: stringValue(app.id) ?? stringValue(window.appId) ?? "unknown",
      name: stringValue(app.name) ?? stringValue(window.appName) ?? "Unknown app",
    },
    window,
    ...(typeof state.capturedAt === "number" ? { capturedAt: state.capturedAt } : {}),
    ...(stringValue(accessibility.selectedText)
      ? { selectedText: stringValue(accessibility.selectedText) }
      : {}),
    ...(stringValue(accessibility.documentText)
      ? { visibleText: stringValue(accessibility.documentText) }
      : {}),
    ...(Array.isArray(state.screenshots) ? { screenshots: state.screenshots } : {}),
    untrusted: true,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function splitDesktopContextImages(snapshot: unknown): { snapshot: unknown; imageBlocks?: unknown[] } {
  const value = asRecord(snapshot);
  if (!Object.keys(value).length) return { snapshot };
  const imageBlocks: unknown[] = [];
  const sanitized = sanitizeSnapshotImages(value, imageBlocks);
  return imageBlocks.length > 0
    ? { snapshot: sanitized, imageBlocks }
    : { snapshot: sanitized };
}

function sanitizeSnapshotImages(value: unknown, imageBlocks: unknown[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSnapshotImages(item, imageBlocks));
  }
  const record = asRecord(value);
  if (!Object.keys(record).length) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === "screenshots" && Array.isArray(item)) {
      output[key] = item.map((candidate) => {
        const screenshot = asRecord(candidate);
        const { dataUrl, ...metadata } = screenshot;
        const image = parseDataUrl(dataUrl);
        if (image) {
          imageBlocks.push({
            type: "image",
            source: image,
            _meta: { screenshotId: typeof screenshot.id === "string" ? screenshot.id : undefined, persist: false },
          });
        }
        return metadata;
      });
      continue;
    }
    output[key] = sanitizeSnapshotImages(item, imageBlocks);
  }
  return output;
}

function parseDataUrl(value: unknown): { type: "base64"; media_type: string; data: string } | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^data:(image\/[^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value);
  if (!match) return undefined;
  return { type: "base64", media_type: match[1]!, data: match[2]!.replace(/\s/g, "") };
}
