/**
 * ThreadEventBus 第二入口领域事件的统一发布口。
 * run 级领域事件(background.task / lsp.diagnostics / coding.report /
 * advisor.reviewed / memory.context.used / todo.state)共用同一骨架:
 * turnId:null、ts:now、kind:"run"、phase:"event",失败仅 warn 不抛。
 * 注意:lifecycle 投影 tee(run-loop 直通投影产物)与 run.end 终值补发
 * (await 保证时序)语义不同,不走此口。
 */
import type { SdkLifecycleEvent } from "@lume/shared";
import { createLogger } from "../../infra/logger";
import { getThreadEventBus } from "./thread-event-bus";

const log = createLogger("bus-bridge");

export interface PublishRunDomainEventInput {
  sessionDir: string;
  threadId: string;
  runId: string;
  /** warn 日志中的事件名,与 detail.type 对齐(如 "background.task") */
  label: string;
  detail: SdkLifecycleEvent["detail"];
}

/** fire-and-forget 发布 run 级领域事件,失败仅 warn(不阻塞主流)。 */
export function publishRunDomainEvent(input: PublishRunDomainEventInput): void {
  void getThreadEventBus(input.sessionDir)
    .publish(input.threadId, input.runId, {
      runId: input.runId,
      turnId: null,
      ts: Date.now(),
      kind: "run",
      phase: "event",
      detail: input.detail
    })
    .catch((error) => {
      log.warn(`${input.label} 总线 publish 失败`, {
        threadId: input.threadId,
        runId: input.runId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
}
