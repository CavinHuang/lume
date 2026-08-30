/**
 * sidecar ↔ desktop main 浏览器命令桥(传输层)。
 *
 * 沿用旧 MAC+sequence postMessage 桥的传输语义(23c03fea9 移除前的
 * browser-rpc-sequence + index.ts requestBrowserMain),载荷换 ZCode 46 命令协议:
 *   - 出站:{ id, method: "lume:browser-execute", params: {context, command}, browserRpc: {sequence, mac} }
 *   - 入站:{ id, result | error, browserRpc: {sequence, mac} }
 *   - MAC:HMAC-SHA256(LUME_BROWSER_RPC_SECRET, "<direction>|<sequence>|<id>|<JSON body>"),
 *     请求 body = params;响应 body = {ok:true,result} | {ok:false,error:code}。
 *   - 序号:出站严格递增;入站单调接受(> 当前值),迟到/失序响应不毒化计数器。
 *
 * 协议版本闸(incompatible_protocol)在上层 browser-gate.ts,本文件只做传输。
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import type { BrowserExecuteRequest } from "@lume/shared";

/** 桥出站请求超时后迟到响应的处理:序号照常推进,结果丢弃。 */
type PendingEntry = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export interface BrowserMainBridge {
  /** 发送 lume:browser-execute 请求;超时(mid)拒绝,迟到响应被丢弃。 */
  execute(request: BrowserExecuteRequest, timeoutMs: number): Promise<Record<string, unknown>>;
  /** 消费 main→sidecar 的浏览器 RPC 响应;非浏览器桥载荷返回 false 交还通用路径。 */
  handleResponse(payload: unknown): boolean;
  /** desktop 死亡/通道断开时批量拒绝在途请求(明确 backend_unavailable,非超时误报)。 */
  failAllPending(): void;
  /** 密钥未注入(main 旧版/测试形态)时桥不可用,工具层以 backend_unavailable 呈现。 */
  isAvailable(): boolean;
}

export interface CreateBrowserMainBridgeOptions {
  send: (line: string) => void;
  /** LUME_BROWSER_RPC_SECRET 的 base64url 解码结果;null 表示传输不可用。 */
  secret: Buffer | null;
}

function mac(direction: "sidecar->main" | "main->sidecar", secret: Buffer, sequence: number, id: string, body: unknown): string {
  return createHmac("sha256", secret)
    .update(`${direction}|${sequence}|${id}|${JSON.stringify(body)}`)
    .digest("base64url");
}

function verifyMac(direction: "main->sidecar", secret: Buffer, sequence: number, id: string, body: unknown, received: unknown): boolean {
  if (typeof received !== "string") return false;
  const expected = Buffer.from(mac(direction, secret, sequence, id, body));
  const actual = Buffer.from(received);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** 响应体(参与 MAC 计算):与 desktop 侧签名口径逐字一致。 */
function responseBody(payload: { result?: unknown; error?: { code?: unknown } | null }): unknown {
  return payload.error
    ? { ok: false, error: typeof payload.error.code === "string" ? payload.error.code : "browser_internal_error" }
    : { ok: true, result: payload.result };
}

export function createBrowserMainBridge(options: CreateBrowserMainBridgeOptions): BrowserMainBridge {
  const { send, secret } = options;
  const pending = new Map<string, PendingEntry>();
  let outboundSequence = 0;
  // 单调推进(旧 classifyBrowserRpcResponse 语义):超时请求的迟到响应仍推进计数器,
  // 否则一次超时把计数器永久毒化,其后所有合法响应都过不了严格 +1。
  let inboundSequence = 0;

  return {
    isAvailable() {
      return secret !== null;
    },

    execute(request, timeoutMs) {
      if (!secret) return Promise.reject(Object.assign(new Error("browser transport unavailable"), { code: "backend_unavailable" }));
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const requestId = request.context.requestId;
        const sequence = ++outboundSequence;
        const timeout = setTimeout(() => {
          pending.delete(requestId);
          reject(Object.assign(new Error("browser request timed out"), { code: "timeout" }));
        }, timeoutMs);
        pending.set(requestId, { resolve, reject, timeout });
        try {
          send(JSON.stringify({
            id: requestId,
            method: "lume:browser-execute",
            params: request,
            browserRpc: { sequence, mac: mac("sidecar->main", secret, sequence, requestId, request) },
          }));
        } catch (error) {
          pending.delete(requestId);
          clearTimeout(timeout);
          reject(Object.assign(error instanceof Error ? error : new Error(String(error)), { code: "backend_unavailable" }));
        }
      });
    },

    handleResponse(payload) {
      if (!payload || typeof payload !== "object") return false;
      const envelope = payload as {
        id?: unknown;
        method?: unknown;
        result?: unknown;
        error?: { code?: unknown } | null;
        browserRpc?: { sequence?: unknown; mac?: unknown };
      };
      if (envelope.method !== undefined || envelope.id === undefined) return false;
      if (!envelope.browserRpc || typeof envelope.browserRpc !== "object") return false;
      const requestId = String(envelope.id);
      const waiting = pending.get(requestId);
      if (!waiting && secret) {
        // 迟到响应(请求已超时删除):无 pending 可推进,直接丢弃;MAC 无需再验。
        return true;
      }
      if (!secret) return false;
      const sequence = envelope.browserRpc.sequence;
      const body = responseBody(envelope);
      const macOk = typeof sequence === "number"
        && verifyMac("main->sidecar", secret, sequence, requestId, body, envelope.browserRpc.mac);
      // 单调接受:MAC 有效且序号 > 当前值才 advance;否则按认证失败拒绝。
      if (!macOk || sequence <= inboundSequence) {
        if (waiting) {
          pending.delete(requestId);
          clearTimeout(waiting.timeout);
          waiting.reject(Object.assign(new Error("browser transport authentication failed"), { code: "backend_unavailable" }));
        }
        return true;
      }
      inboundSequence = sequence;
      if (!waiting) return true;
      pending.delete(requestId);
      clearTimeout(waiting.timeout);
      if (envelope.error) {
        const code = typeof envelope.error.code === "string" && envelope.error.code ? envelope.error.code : "browser_internal_error";
        const message = typeof (envelope.error as { message?: unknown }).message === "string"
          ? (envelope.error as { message: string }).message
          : code;
        waiting.reject(Object.assign(new Error(message), { code }));
      } else {
        waiting.resolve(
          envelope.result && typeof envelope.result === "object" && !Array.isArray(envelope.result)
            ? envelope.result as Record<string, unknown>
            : { ok: true },
        );
      }
      return true;
    },

    failAllPending() {
      for (const [requestId, waiting] of [...pending]) {
        pending.delete(requestId);
        clearTimeout(waiting.timeout);
        // 断连 = 包未送达,报可重试的 backend_unavailable,而非超时的"可能已执行"。
        waiting.reject(Object.assign(new Error("browser transport disconnected"), { code: "backend_unavailable" }));
      }
    },
  };
}

/* ── 进程级单例(组合根 index.ts 注入;工具层经 holder 取用) ────────── */

let activeBridge: BrowserMainBridge | null = null;

export function setActiveBrowserMainBridge(bridge: BrowserMainBridge | null): void {
  activeBridge = bridge;
}

export function getActiveBrowserMainBridge(): BrowserMainBridge | null {
  return activeBridge;
}
