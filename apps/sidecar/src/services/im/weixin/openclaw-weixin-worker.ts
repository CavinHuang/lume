import type { ImAccountUpdateInput } from "@lume/shared";
import type { ImRuntimeAccount } from "../im-config-manager";
import type {
  OpenClawWeixinApi,
  OpenClawWeixinInboundMessage
} from "./openclaw-weixin-api";
import { createOpenClawWeixinApi } from "./openclaw-weixin-api";
import type { InboundImRouteMessage } from "../im-message-router";
import { routeInboundImMessage } from "../im-message-router";

export interface OpenClawWeixinWorker {
  start(): void;
  stop(): void;
  processOnce(): Promise<void>;
  isRunning(): boolean;
}

export interface CreateOpenClawWeixinWorkerInput {
  account: ImRuntimeAccount;
  api?: OpenClawWeixinApi;
  routeMessage?: (message: InboundImRouteMessage) => Promise<void> | void;
  updateAccount?: (id: string, input: ImAccountUpdateInput) => Promise<void> | void;
  pollIntervalMs?: number;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}

function lastContextToken(messages: OpenClawWeixinInboundMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const token = messages[index]?.contextToken;
    if (token) return token;
  }
  return undefined;
}

export function createOpenClawWeixinWorker(input: CreateOpenClawWeixinWorkerInput): OpenClawWeixinWorker {
  const api = input.api ?? createOpenClawWeixinApi({
    baseUrl: input.account.baseUrl,
    token: input.account.token,
    uin: input.account.uin
  });
  const routeMessage = input.routeMessage ?? routeInboundImMessage;
  const updateAccount = input.updateAccount ?? (() => undefined);
  const pollIntervalMs = input.pollIntervalMs ?? 1000;
  let running = false;
  let abortController: AbortController | null = null;
  let cursor = input.account.cursor;

  async function processOnce(): Promise<void> {
    const batch = await api.getUpdates({
      cursor,
      signal: abortController?.signal
    });
    for (const update of batch.updates) {
      await routeMessage({
        provider: "weixin",
        accountId: input.account.id,
        accountLabel: input.account.label,
        peerKind: update.peerKind,
        peerId: update.peerId,
        peerName: update.peerName,
        text: update.text,
        contextToken: update.contextToken,
        messageId: update.messageId
      });
    }
    cursor = batch.cursor ?? cursor;
    await updateAccount(input.account.id, {
      status: "running",
      ...(cursor ? { cursor } : {}),
      ...(lastContextToken(batch.updates) ? { contextToken: lastContextToken(batch.updates) } : {}),
      lastError: null
    });
  }

  async function loop(): Promise<void> {
    while (running) {
      try {
        await processOnce();
      } catch (error) {
        if (!isAbortError(error)) {
          await updateAccount(input.account.id, {
            status: "error",
            lastError: error instanceof Error ? error.message : String(error)
          });
        }
      }
      if (running) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      abortController = new AbortController();
      void api.notifyStart().catch((error) => {
        console.warn("[IM] 微信 start 通知失败:", error);
      });
      void loop();
    },
    stop() {
      running = false;
      abortController?.abort();
      abortController = null;
      void api.notifyStop().catch((error) => {
        console.warn("[IM] 微信 stop 通知失败:", error);
      });
    },
    processOnce,
    isRunning() {
      return running;
    }
  };
}
