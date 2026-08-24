import type { LumeRuntimeEvent } from "@lume/shared";
import { getImThreadBindingByThreadId } from "./im-thread-binding-store";
import { getImRuntimeAccount } from "./im-config-manager";
import { createFeishuCardStream, type FeishuCardStream } from "./feishu/feishu-card-stream";
import { createLogger } from "../infra/logger";

const log = createLogger("im-run-card");

/**
 * 一次 agent 运行的流式卡片会话（当前仅飞书渠道启用）。
 *
 * 生命周期与路由器为每次提交创建的 emitter 同生共死：首个内容类运行时事件
 * 到达时打开卡片，此后事件经 reducer 节流推送；finish 由 emitter 的完成/
 * 失败回调触发终态强刷。打开失败自动降级：调用方据 settleOpen 结果回退
 * 纯文本投递，回复不丢失。
 */

/** 触发开卡的事件类型：出现即代表本次运行有可展示的活动 */
const OPEN_TRIGGER_EVENTS = new Set([
  "assistant.delta",
  "assistant.thinking_delta",
  "assistant.final",
  "tool.started"
]);

export interface ImRunCardFinishStatus {
  kind: "completed" | "failed" | "interrupted" | "turn_limited";
  error?: string;
}

export interface ImRunCardSession {
  /** 运行时事件入卡；未开卡时仅首个触发类事件会真正建卡 */
  handleEvent: (event: LumeRuntimeEvent) => void;
  /** 终态强刷；幂等 */
  finish: (status: ImRunCardFinishStatus) => void;
  /** 是否启用卡片通道（非飞书/缺凭据返回 false） */
  isEnabled: () => boolean;
  /**
   * 卡片通道是否确定可用。resolve 值为 false 表示开卡失败，
   * 调用方应回退纯文本投递。
   */
  settleOpen: () => Promise<boolean>;
}

function finishEventOf(status: ImRunCardFinishStatus): LumeRuntimeEvent {
  switch (status.kind) {
    case "failed":
      return {
        id: `card-finish:failed:${Date.now()}`,
        type: "run.failed",
        threadId: "",
        runId: "",
        createdAt: new Date().toISOString(),
        error: { code: "im_run_failed", message: status.error ?? "运行失败" }
      } as LumeRuntimeEvent;
    case "interrupted":
      return {
        id: `card-finish:interrupted:${Date.now()}`,
        type: "run.cancelled",
        threadId: "",
        runId: "",
        createdAt: new Date().toISOString()
      } as LumeRuntimeEvent;
    case "turn_limited":
      return {
        id: `card-finish:turn_limited:${Date.now()}`,
        type: "run.turn_limited",
        threadId: "",
        runId: "",
        createdAt: new Date().toISOString()
      } as LumeRuntimeEvent;
    default:
      return {
        id: `card-finish:completed:${Date.now()}`,
        type: "run.completed",
        threadId: "",
        runId: "",
        createdAt: new Date().toISOString()
      } as LumeRuntimeEvent;
  }
}

/** 测试注入钩子：替换会话构造（路由器测试用它模拟卡片通道开/关）。 */
let sessionFactoryForTest: ((threadId: string) => ImRunCardSession | null) | null = null;

export function setImRunCardSessionFactoryForTest(
  factory: ((threadId: string) => ImRunCardSession | null) | null
): void {
  sessionFactoryForTest = factory;
}

export function createImRunCardSession(threadId: string): ImRunCardSession | null {
  if (sessionFactoryForTest) {
    return sessionFactoryForTest(threadId);
  }
  return createImRunCardSessionInternal(threadId);
}

function createImRunCardSessionInternal(threadId: string): ImRunCardSession | null {
  const binding = getImThreadBindingByThreadId(threadId);
  if (!binding || binding.provider !== "feishu") {
    return null;
  }
  const account = getImRuntimeAccount(binding.accountId);
  const appId = account.accountKey ?? "";
  const appSecret = account.token ?? "";
  if (!appId || !appSecret) {
    log.warn("飞书账号缺少凭据，跳过流式卡片", { accountId: binding.accountId });
    return null;
  }

  const stream: FeishuCardStream = createFeishuCardStream({
    appId,
    appSecret,
    chatId: binding.peerId
  });

  let opening: Promise<boolean> | null = null;
  let openOutcome: boolean | null = null;
  let finished = false;

  const ensureOpened = (): void => {
    if (opening) return;
    opening = stream.open().then((ok) => {
      openOutcome = ok;
      if (!ok) {
        stream.close();
        log.info("卡片通道不可用，回退文本回复", { threadId });
      }
      return ok;
    });
    opening.catch(() => {
      openOutcome = false;
    });
  };

  return {
    handleEvent: (event) => {
      if (finished) return;
      // 开卡决策只看内容类事件；开卡后全量转发（含 run.* 终态，reducer 自行判重）
      if (!opening && OPEN_TRIGGER_EVENTS.has(event.type)) {
        ensureOpened();
      }
      if (opening) {
        stream.apply(event);
      }
    },
    finish: (status) => {
      if (finished) return;
      finished = true;
      // 未曾开过卡（无任何内容事件即终态）：无需建空卡
      if (!opening) {
        return;
      }
      stream.apply(finishEventOf(status));
    },
    isEnabled: () => true,
    settleOpen: () => {
      // open 理论不 reject（内部已捕获）；兜底按失败处理走文本回退
      return (opening?.catch(() => false) ?? Promise.resolve(false)) as Promise<boolean>;
    }
  };
}
