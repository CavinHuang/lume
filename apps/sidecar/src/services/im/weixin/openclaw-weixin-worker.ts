import type { ImAccountUpdateInput } from "@lume/shared";
import type { ImRuntimeAccount } from "../im-config-manager";
import type {
  OpenClawWeixinApi,
  OpenClawWeixinInboundMessage
} from "./openclaw-weixin-api";
import {
  createOpenClawWeixinApi,
  isOpenClawWeixinAuthError
} from "./openclaw-weixin-api";
import type { InboundImRouteMessage } from "../im-message-router";
import { routeInboundImMessage } from "../im-message-router";
import { createLogger } from "../../infra/logger";

const log = createLogger("im-worker");

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

const MAX_SEEN_MESSAGE_IDS = 1000;

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
  const seenMessageIds = new Set<string>();
  const seenMessageOrder: string[] = [];

  function hasSeenMessage(messageId: string | undefined): boolean {
    if (!messageId) return false;
    return seenMessageIds.has(`${input.account.id}:${messageId}`);
  }

  function rememberMessage(messageId: string | undefined): void {
    if (!messageId) return;
    const key = `${input.account.id}:${messageId}`;
    if (seenMessageIds.has(key)) return;
    seenMessageIds.add(key);
    seenMessageOrder.push(key);
    while (seenMessageOrder.length > MAX_SEEN_MESSAGE_IDS) {
      const staleKey = seenMessageOrder.shift();
      if (staleKey) seenMessageIds.delete(staleKey);
    }
  }

  async function processOnce(): Promise<void> {
    const batch = await api.getUpdates({
      cursor,
      signal: abortController?.signal
    });
    for (const update of batch.updates) {
      if (hasSeenMessage(update.messageId)) continue;
      log.info("处理新消息", { accountId: input.account.id, peerId: update.peerId, peerKind: update.peerKind, messageId: update.messageId });
      await routeMessage({
        provider: "weixin",
        accountId: input.account.id,
        accountLabel: input.account.label,
        workspaceId: input.account.workspaceId,
        peerKind: update.peerKind,
        peerId: update.peerId,
        peerName: update.peerName,
        senderId: update.senderId,
        text: update.text,
        contents: update.contents,
        contextToken: update.contextToken,
        messageId: update.messageId
      });
      rememberMessage(update.messageId);
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
          if (isOpenClawWeixinAuthError(error)) {
            log.error("认证失败，停止轮询", { accountId: input.account.id, error: error instanceof Error ? error.message : String(error) });
            running = false;
            await updateAccount(input.account.id, {
              status: "auth_required",
              lastError: error instanceof Error ? error.message : String(error)
            });
            continue;
          }
          log.error("轮询处理出错", { accountId: input.account.id, error: error instanceof Error ? error.message : String(error) });
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
      log.info("Worker 启动", { accountId: input.account.id });
      void api.notifyStart().catch((error) => {
        log.warn("微信 start 通知失败", { accountId: input.account.id, error: error instanceof Error ? error.message : String(error) });
      });
      void loop();
    },
    stop() {
      running = false;
      abortController?.abort();
      abortController = null;
      log.info("Worker 停止", { accountId: input.account.id });
      void api.notifyStop().catch((error) => {
        log.warn("微信 stop 通知失败", { accountId: input.account.id, error: error instanceof Error ? error.message : String(error) });
      });
    },
    processOnce,
    isRunning() {
      return running;
    }
  };
}
