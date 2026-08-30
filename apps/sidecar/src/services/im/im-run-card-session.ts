import type { LumeRuntimeEvent } from "@lume/shared";
import { getImThreadBindingByThreadId } from "./im-thread-binding-store";
import { getImRuntimeAccount } from "./im-config-manager";
import { sendBoundImTextMessage } from "./im-send-service";
import {
  createFeishuCardStream,
  type FeishuCardStream,
  type FeishuCardStreamOptions
} from "./feishu/feishu-card-stream";
import { getAgentRuntimeStatusManager } from "../agent/agent-runtime-status-manager";
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
  /** 卡片通道已降级（持续推送失败）：调用方应放弃互斥、回退文本投递 */
  isDegraded: () => boolean;
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

/** 测试注入钩子：替换底层卡片流（订阅链路测试用它拦截网络边界，免 mock.module 全局污染）。 */
let streamFactoryForTest: ((options: FeishuCardStreamOptions) => FeishuCardStream) | null = null;

export function setImRunCardStreamFactoryForTest(
  factory: ((options: FeishuCardStreamOptions) => FeishuCardStream) | null
): void {
  streamFactoryForTest = factory;
}

export function createImRunCardSession(threadId: string): ImRunCardSession | null {
  if (sessionFactoryForTest) {
    return sessionFactoryForTest(threadId);
  }
  return createImRunCardSessionInternal(threadId);
}

export interface BuildImRunCardSessionInput {
  threadId: string;
  accountId: string;
  appId: string;
  appSecret: string;
  /** 卡片宿主会话 chat_id：DM=绑定 peer；#544 镜像=镜像群 chat */
  chatId: string;
  /** 终态强刷失败兜底（入参为卡内累计正文），缺省时仅落日志。 */
  onTerminalFlushFailed?: (finalText: string) => void;
}

/**
 * 参数化构造器：宿主会话由调用方决定——路由器绑定 peer（既有 DM 卡片）
 * 与 #544 镜像服务（镜像群）复用同一压缩/开卡/终态全栈。
 */
export function buildImRunCardSession(input: BuildImRunCardSessionInput): ImRunCardSession {
  const threadId = input.threadId;

  const streamOptions: FeishuCardStreamOptions = {
    accountId: input.accountId,
    appId: input.appId,
    appSecret: input.appSecret,
    chatId: input.chatId,
    // 终态刷不出时回复内容只在卡上：兜底回调携带卡内累计正文，回复不丢失
    ...(input.onTerminalFlushFailed
      ? {
          onTerminalFlushFailed: () => {
            const finalText = stream.state.blocks
              .filter((block) => block.kind === "text")
              .map((block) => block.text)
              .join("\n\n")
              .trim();
            input.onTerminalFlushFailed?.(finalText);
          }
        }
      : {})
  };
  const stream: FeishuCardStream = streamFactoryForTest
    ? streamFactoryForTest(streamOptions)
    : createFeishuCardStream(streamOptions);

  let opening: Promise<boolean> | null = null;
  let openOutcome: boolean | null = null;
  let finished = false;

  // 压缩中间态（#709 第 4 项，#725 review R8）：runtime event 流不发
  // context.compaction.*（T7a 后 live 走事件总线，IM 无订阅），改从
  // runtimeStatusManager 的 compacting phase 订阅驱动卡片状态。合成事件
  // 直喂 reducer，幂等由其引用相等保证；终态退订防泄漏。
  const runtimeStatuses = getAgentRuntimeStatusManager();
  let statusPhaseCompacting = false;
  const applyCompactionState = (compacting: boolean): void => {
    statusPhaseCompacting = compacting;
    const now = new Date().toISOString();
    stream.apply({
      id: `card:compaction:${compacting ? "started" : "completed"}:${now}`,
      type: compacting ? "context.compaction.started" : "context.compaction.completed",
      threadId,
      runId: "",
      createdAt: now,
      trigger: "auto",
      preTokens: 0,
      policy: "",
      source: ""
    } as LumeRuntimeEvent);
  };
  const unsubRuntimeStatus = runtimeStatuses.subscribe((status) => {
    if (finished || !opening || status.threadId !== threadId) return;
    const compacting = status.phase === "compacting";
    if (compacting !== statusPhaseCompacting) applyCompactionState(compacting);
  });

  const ensureOpened = (): void => {
    if (opening) return;
    opening = stream.open().then((ok) => {
      openOutcome = ok;
      if (!ok) {
        unsubRuntimeStatus();
        stream.close();
        log.info("卡片通道不可用，回退文本回复", { threadId });
        return ok;
      }
      // 对齐开卡前已置位的压缩态（订阅回调对未开卡期间的变化不落状态）
      const current = runtimeStatuses.get(threadId);
      if (current?.phase === "compacting" && !statusPhaseCompacting) {
        applyCompactionState(true);
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
      unsubRuntimeStatus();
      // 未曾开过卡（无任何内容事件即终态）：无需建空卡
      if (!opening) {
        stream.close();
        return;
      }
      stream.apply(finishEventOf(status));
    },
    isEnabled: () => true,
    isDegraded: () => stream.degraded,
    settleOpen: () => {
      // open 理论不 reject（内部已捕获）；兜底按失败处理走文本回退
      return (opening?.catch(() => false) ?? Promise.resolve(false)) as Promise<boolean>;
    }
  };
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

  return buildImRunCardSession({
    threadId,
    accountId: binding.accountId,
    appId,
    appSecret,
    chatId: binding.peerId,
    // 终态刷不出时兜底补发最终文本到原绑定会话，回复不丢失
    onTerminalFlushFailed: (finalText) => {
      if (!finalText) return;
      sendBoundImTextMessage({ binding, text: finalText }).catch((error: unknown) => {
        log.error("卡片终态兜底文本发送失败", {
          threadId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
  });
}
