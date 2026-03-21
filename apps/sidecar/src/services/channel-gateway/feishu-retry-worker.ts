import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { ChannelDeliveryRecord } from "@lume/shared";
import { getChannelGatewayDeliveryPath } from "../config-paths";
import { sendFeishuTextMessage } from "./feishu-api";
import { dequeueDueChannelRetries, enqueueChannelRetry } from "./retry-queue-manager";

const POLL_INTERVAL_MS = 15_000;
const MAX_ATTEMPTS = 6;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

function appendDelivery(record: ChannelDeliveryRecord): void {
  appendFileSync(getChannelGatewayDeliveryPath(), `${JSON.stringify(record)}\n`, "utf-8");
}

async function processOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const due = dequeueDueChannelRetries();
    for (const item of due) {
      if (item.provider !== "feishu" || !item.externalChatId || !item.text) {
        continue;
      }
      try {
        const sent = await sendFeishuTextMessage({
          chatId: item.externalChatId,
          text: item.text,
          replyToMessageId: item.replyToMessageId
        });
        appendDelivery({
          id: randomUUID(),
          provider: "feishu",
          outboundMessageId: item.outboundMessageId,
          status: "sent",
          attempts: item.attempts + 1,
          externalMessageId: sent.messageId,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
      } catch (error) {
        const nextAttempts = item.attempts + 1;
        const errorMessage = error instanceof Error ? error.message : String(error);
        appendDelivery({
          id: randomUUID(),
          provider: "feishu",
          outboundMessageId: item.outboundMessageId,
          status: "failed",
          attempts: nextAttempts,
          error: errorMessage,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
        if (nextAttempts < MAX_ATTEMPTS) {
          enqueueChannelRetry({
            provider: "feishu",
            outboundMessageId: item.outboundMessageId,
            reason: errorMessage,
            externalChatId: item.externalChatId,
            text: item.text,
            replyToMessageId: item.replyToMessageId,
            attempts: nextAttempts,
            retryAfterMs: Math.min(15 * 60_000, 30_000 * nextAttempts)
          });
        }
      }
    }
  } finally {
    running = false;
  }
}

export function startFeishuRetryWorker(): void {
  if (timer) return;
  timer = setInterval(() => {
    void processOnce().catch((error) => {
      console.error("[ChannelGateway] 飞书重试 worker 执行失败:", error);
    });
  }, POLL_INTERVAL_MS);
}

export function stopFeishuRetryWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export const __internal = {
  processOnce
};
