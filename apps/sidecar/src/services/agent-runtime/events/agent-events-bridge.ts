/**
 * agent:events 推送桥的进程级单源(#549)：桌面 RPC / IM 渠道 / 规划入口等所有
 * run 入口统一经此建桥。每线程订阅一次（去重防重复注册），不随单次 run 退订
 * ——覆盖排队消息/恢复等所有 run 入口，且规避 run 结束瞬间 16ms 微批 update
 * 尚未 flush 就退订的推送丢失。
 *
 * writer 由 RPC 层注入（sidecar→desktop 通知通道）；未注入时订阅照常建立，
 * envelope 仅被丢弃，注入后自动恢复推送（启动窗口内的缺口由 web 端 push
 * 空洞对账兜底）。
 */
import { AGENT_IPC_CHANNELS } from "@lume/shared";
import { createLogger } from "../../infra/logger";
import { getRuntimeCoreSessionDir } from "../runtime-core/session-store";
import { getThreadEventBus, releaseThreadEventBus } from "./thread-event-bus";

const log = createLogger("agent-events-bridge");

type EventsWriter = (channel: string, payload: unknown) => void;

let writer: EventsWriter | null = null;
let pushFailureLogged = false;
const unsubs = new Map<string, () => void>();

export function setAgentEventsBridgeWriter(value: EventsWriter | null): void {
  writer = value;
}

export function ensureAgentEventsBridge(threadId: string): void {
  if (unsubs.has(threadId)) return;
  const unsubscribe = getThreadEventBus(getRuntimeCoreSessionDir(threadId)).subscribe(threadId, (envelope) => {
    if (!writer) return;
    try {
      writer(AGENT_IPC_CHANNELS.EVENTS, envelope);
      pushFailureLogged = false;
    } catch (error) {
      // 单条推送失败不拖垮总线订阅链；首失败 warn 一次定位通道故障，
      // 之后静默避免高频 envelope 刷屏（对齐 bus-bridge 的发布侧惯例）
      if (!pushFailureLogged) {
        pushFailureLogged = true;
        log.warn("agent events 推送失败（后续同类失败静默）", {
          threadId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  });
  unsubs.set(threadId, unsubscribe);
}

/** 线程硬删除路径统一释放：退订事件桥 + 释放该线程的总线 state（bus 实例随之按 sessionDir 卸载）。 */
export function releaseThreadEventBridge(threadId: string): void {
  unsubs.get(threadId)?.();
  unsubs.delete(threadId);
  releaseThreadEventBus(getRuntimeCoreSessionDir(threadId), threadId);
}
