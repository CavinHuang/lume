import {
  DESKTOP_CONTEXT_IPC_CHANNELS,
  type DesktopAssistantSettings,
  type DesktopProactiveProposalStatus,
} from "@lume/shared";
import type { RpcHandler } from "./types";

interface DesktopContextRpcService {
  unlock(key: Buffer): void;
  captureCurrent(input?: { userInitiated?: boolean }): Promise<unknown>;
  requestPermissions(): Promise<unknown>;
  currentContext(input?: { snapshotId?: string; includeScreenshot?: boolean; refresh?: boolean }): Promise<unknown>;
  searchContext(input: { query?: string; limit?: number }): Promise<unknown>;
  getSettings(): DesktopAssistantSettings;
  updateSettings(settings: DesktopAssistantSettings): DesktopAssistantSettings | void;
  getStatus(): Promise<unknown>;
  clear(): { cleared: boolean };
  listActivity(limit?: number): unknown[];
  listProposals(): unknown[];
  updateProposal(id: string, status: DesktopProactiveProposalStatus): unknown;
}

export function createDesktopContextHandlers(service: DesktopContextRpcService): Record<string, RpcHandler> {
  return {
    [DESKTOP_CONTEXT_IPC_CHANNELS.UNLOCK]: async (params) => {
      const keyValue = readRecord(params).key;
      const key = typeof keyValue === "string" ? Buffer.from(keyValue, "base64") : Buffer.alloc(0);
      if (key.length !== 32) throw new Error("desktop context key must decode to 32-byte data");
      service.unlock(key);
      key.fill(0);
      return { ok: true };
    },
    [DESKTOP_CONTEXT_IPC_CHANNELS.CAPTURE_CURRENT]: async (params) => {
      const input = readRecord(params);
      return service.captureCurrent({
        ...(input.userInitiated === true ? { userInitiated: true } : {}),
      });
    },
    [DESKTOP_CONTEXT_IPC_CHANNELS.REQUEST_PERMISSIONS]: async () => service.requestPermissions(),
    [DESKTOP_CONTEXT_IPC_CHANNELS.GET_CURRENT]: async (params) => {
      const input = readRecord(params);
      return service.currentContext({
        ...(typeof input.snapshotId === "string" ? { snapshotId: input.snapshotId } : {}),
        ...(input.includeScreenshot === true ? { includeScreenshot: true } : {}),
        ...(input.refresh === true ? { refresh: true } : {}),
      });
    },
    [DESKTOP_CONTEXT_IPC_CHANNELS.SEARCH]: async (params) => {
      const input = readRecord(params);
      return service.searchContext({
        ...(typeof input.query === "string" ? { query: input.query } : {}),
        ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
      });
    },
    [DESKTOP_CONTEXT_IPC_CHANNELS.GET_SETTINGS]: async () => service.getSettings(),
    [DESKTOP_CONTEXT_IPC_CHANNELS.UPDATE_SETTINGS]: async (params) => {
      return service.updateSettings(readRecord(params) as unknown as DesktopAssistantSettings);
    },
    [DESKTOP_CONTEXT_IPC_CHANNELS.GET_STATUS]: async () => service.getStatus(),
    [DESKTOP_CONTEXT_IPC_CHANNELS.CLEAR]: async () => service.clear(),
    [DESKTOP_CONTEXT_IPC_CHANNELS.LIST_ACTIVITY]: async (params) => {
      const limit = readRecord(params).limit;
      return service.listActivity(typeof limit === "number" ? limit : undefined);
    },
    [DESKTOP_CONTEXT_IPC_CHANNELS.LIST_PROPOSALS]: async () => service.listProposals(),
    [DESKTOP_CONTEXT_IPC_CHANNELS.UPDATE_PROPOSAL]: async (params) => {
      const input = readRecord(params);
      if (typeof input.id !== "string") throw new Error("proposal id is required");
      if (!isProposalStatus(input.status)) throw new Error("invalid proposal status");
      return service.updateProposal(input.id, input.status);
    },
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isProposalStatus(value: unknown): value is DesktopProactiveProposalStatus {
  return value === "pending"
    || value === "opened"
    || value === "accepted"
    || value === "dismissed"
    || value === "expired";
}
