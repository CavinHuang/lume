/**
 * IAB 后端 —— ZCode 形状的模型侧后端描述符 + 46 命令执行入口。
 *
 * 来源:zcode-browser-panel-architecture.md §14(门面语义)/§18.4(宿主侧配合)、
 * docs/plans/2026-08-30-browser-rewrite-design.md §1(sidecar IAB backend 行)。
 *
 * - 描述符:id "iab:<uuid>"、generation、capabilities(唯一 visibility)、
 *   apiSupportOverrides(claimTab/finalize/markDeliverable/markHandoff/recording.* 强制开)。
 * - execute({context, command}):经 MAC 桥送 main 的 BrowserGuestManager.execute,
 *   默认 30s 超时(playwright/waitFor 系 +2s);超时先补发 cancelRequest 再返回
 *   timeout + sideEffect 标注(guide §14 超时策略;无自动重试,重试决策留给模型)。
 * - turnEnded/closeSession:turn 生命周期通知(fire-and-forget,失败静默)。
 */
import { randomUUID } from "node:crypto";

import {
  browserCommandResultSchema,
  browserErrorPayload,
  buildIabDescriptor,
  cancellationSideEffect,
  firstBrowserParseIssuePath,
  type BrowserBackendDescriptor,
  type BrowserCommand,
  type BrowserCommandContext,
  type BrowserCommandResult,
  type BrowserErrorPayload,
  type BrowserExecuteRequest,
} from "@lume/shared";

import { assertBrowserProtocolCompatible, BrowserProtocolGateError, BROWSER_PROTOCOL_INCOMPATIBLE } from "./browser-gate";
import { getActiveBrowserMainBridge, type BrowserMainBridge } from "./bridge-transport";

/* ── 描述符 ────────────────────────────────────────────────────────── */

/**
 * ZCode 后端描述符(guide §14/§18.4;generation 刻意不对模型暴露)。
 * 共享形状单源自 shared/descriptor.ts;provider 元数据为本端附加字段。
 */
export interface BrowserIabDescriptor extends BrowserBackendDescriptor {
  metadata: { provider: string };
}

/* ── 超时策略 ──────────────────────────────────────────────────────── */

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const PLAYWRIGHT_EXTRA_TIMEOUT_MS = 2_000;
const CANCEL_REQUEST_TIMEOUT_MS = 5_000;
const LIFECYCLE_NOTIFY_TIMEOUT_MS = 5_000;

/** playwright/waitFor 系命令 +2s 余量(guide §14 "playwright/waitFor +2s")。 */
export function browserCommandTimeoutMs(command: BrowserCommand, baseTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): number {
  return command.method === "playwright" || command.method === "playwrightWaitForTimeout" || command.method === "waitFor"
    ? baseTimeoutMs + PLAYWRIGHT_EXTRA_TIMEOUT_MS
    : baseTimeoutMs;
}

/* ── 后端 ──────────────────────────────────────────────────────────── */

/** 传输口(生产实现为 bridge-transport 的 MAC 桥;测试注入 fake)。 */
export interface BrowserMainTransport {
  execute(request: BrowserExecuteRequest, timeoutMs: number): Promise<Record<string, unknown>>;
  isAvailable(): boolean;
}

/** turn 生命周期通知所需的会话定位(其余上下文成分由后端补全)。 */
export interface BrowserSessionRef {
  sessionId: string;
  workspaceKey: string;
  turnId?: string;
}

export interface IabExecuteInput {
  context: BrowserCommandContext;
  command: BrowserCommand;
}

export interface BrowserIabBackend {
  descriptor: BrowserIabDescriptor;
  execute(input: IabExecuteInput): Promise<BrowserCommandResult>;
  /** agent 运行时每轮结束发出(main endTurn:abort 该 turn 录制与在途请求)。 */
  turnEnded(session: BrowserSessionRef): Promise<void>;
  /** 会话关闭发出(main closeSession:全部 abort + releaseToUser)。 */
  closeSession(session: BrowserSessionRef): Promise<void>;
}

export interface CreateIabBrowserBackendOptions {
  transport?: BrowserMainTransport;
  /** 覆盖默认 30s 基准(playwright/waitFor 系仍 +2s);测试/宿主调优用。 */
  baseTimeoutMs?: number;
  uuid?: () => string;
  now?: () => number;
}

function bridgeTransport(bridge: BrowserMainBridge): BrowserMainTransport {
  return { execute: (request, timeoutMs) => bridge.execute(request, timeoutMs), isAvailable: () => bridge.isAvailable() };
}

export function createIabBrowserBackend(options: CreateIabBrowserBackendOptions = {}): BrowserIabBackend {
  const uuid = options.uuid ?? randomUUID;
  const now = options.now ?? Date.now;
  // 协议闸闩:一旦拿到正向不相容证据即 fail closed,后续命令不再打穿传输。
  let protocolBlockedMessage: string | null = null;

  const descriptor: BrowserIabDescriptor = {
    ...buildIabDescriptor({ id: `iab:${uuid()}`, generation: now(), name: "Lume In-app Browser" }),
    metadata: { provider: "lume-desktop-iab" },
  };

  const resolveTransport = (): BrowserMainTransport => {
    const transport = options.transport ?? bridgeTransportByActiveBridge();
    if (!transport.isAvailable()) {
      throw Object.assign(new Error("browser transport unavailable"), { code: "backend_unavailable" });
    }
    return transport;
  };

  function buildContext(base: BrowserSessionRef): BrowserCommandContext {
    return {
      requestId: uuid(),
      sessionId: base.sessionId,
      turnId: base.turnId,
      workspaceKey: base.workspaceKey,
      browserId: descriptor.id,
      browserGeneration: descriptor.generation,
      clientMode: "desktop-continuous",
    };
  }

  /** 超时后的取消:先补发 cancelRequest(独立 requestId,避免 duplicate_request_id)再返回。 */
  async function cancelAbandoned(context: BrowserCommandContext): Promise<void> {
    try {
      const transport = resolveTransport();
      await transport.execute(
        {
          context: { ...context, requestId: uuid() },
          command: { method: "cancelRequest", requestId: context.requestId },
        },
        CANCEL_REQUEST_TIMEOUT_MS,
      );
    } catch {
      // 取消本身失败不再叠加误导:主结果已是 timeout + sideEffect 标注。
    }
  }

  // "incompatible_protocol" 是闸的扩展码(旧 sidecar 稳定码集同款,e5ec4503d):
  // 不入 shared 稳定码集,但作为结果负载跨进程可见。
  type GateExtendedErrorCode = BrowserErrorPayload["code"] | typeof BROWSER_PROTOCOL_INCOMPATIBLE;

  function errorResult(code: GateExtendedErrorCode, message: string, sideEffect?: BrowserErrorPayload["sideEffect"]): BrowserCommandResult {
    return { ok: false, error: browserErrorPayload(code as BrowserErrorPayload["code"], message, sideEffect) } as BrowserCommandResult;
  }

  return {
    descriptor,

    async execute({ context, command }: IabExecuteInput): Promise<BrowserCommandResult> {
      const startedAt = now();
      if (protocolBlockedMessage) {
        return errorResult(BROWSER_PROTOCOL_INCOMPATIBLE, protocolBlockedMessage);
      }
      const timeoutMs = browserCommandTimeoutMs(command);
      let raw: Record<string, unknown>;
      try {
        raw = await resolveTransport().execute({ context, command }, timeoutMs);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code === "timeout") {
          // 超时策略(guide §14):先补发 cancelRequest 再返回;命令已派发,
          // 副作用命令标 uncertain(可能已发生且不回滚),只读命令标 none。
          await cancelAbandoned(context);
          return errorResult(
            "timeout",
            `browser 命令 ${command.method} 超时(${timeoutMs}ms)`,
            cancellationSideEffect(command, true),
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        return errorResult("backend_unavailable", message.slice(0, 500));
      }
      try {
        assertBrowserProtocolCompatible(raw);
      } catch (error) {
        protocolBlockedMessage = error instanceof BrowserProtocolGateError ? error.message : String(error);
        return errorResult(BROWSER_PROTOCOL_INCOMPATIBLE, protocolBlockedMessage);
      }
      const parsed = browserCommandResultSchema.safeParse(raw);
      if (!parsed.success) {
        return errorResult("execution_error", `invalid browser command result: ${firstBrowserParseIssuePath(parsed.error)}`);
      }
      return parsed.data as BrowserCommandResult;
    },

    async turnEnded(session: BrowserSessionRef): Promise<void> {
      await notify("turnEnded", session);
    },

    async closeSession(session: BrowserSessionRef): Promise<void> {
      await notify("closeSession", session);
    },
  };

  async function notify(method: "turnEnded" | "closeSession", session: BrowserSessionRef): Promise<void> {
    try {
      const command: BrowserCommand = method === "turnEnded" ? { method: "turnEnded", turnId: session.turnId } : { method: "closeSession" };
      await resolveTransport().execute({ context: buildContext(session), command }, LIFECYCLE_NOTIFY_TIMEOUT_MS);
    } catch {
      // 生命周期通知是尽力而为:main 不在场时静默放弃,不误导当前命令结果。
    }
  }
}

function bridgeTransportByActiveBridge(): BrowserMainTransport {
  const bridge = getActiveBrowserMainBridge();
  if (!bridge) {
    throw Object.assign(new Error("browser transport unavailable"), { code: "backend_unavailable" });
  }
  return bridgeTransport(bridge);
}

/* ── 进程级单例(一个 sidecar 进程对应一个内嵌浏览器后端) ──────────── */

let activeBackend: BrowserIabBackend | null = null;

export function getActiveIabBrowserBackend(): BrowserIabBackend {
  if (!activeBackend) activeBackend = createIabBrowserBackend();
  return activeBackend;
}

/** 测试/组合根注入;传 null 恢复惰性默认。 */
export function setActiveIabBrowserBackend(backend: BrowserIabBackend | null): void {
  activeBackend = backend;
}

/** 工具注册门控:传输桥可用(密钥注入)才把浏览器工具暴露给模型。 */
export function isIabBrowserTransportAvailable(): boolean {
  return getActiveBrowserMainBridge()?.isAvailable() === true;
}
