/**
 * 浏览器反向 RPC 入站响应的序号判定。
 *
 * 接受条件为"MAC 有效且序号严格大于当前值"（单调推进），而非严格 +1：
 * 请求超时后其迟到响应仍可推进计数器，否则一次超时会把计数器永久毒化，
 * 此后所有合法响应都满足不了 +1 而报认证失败（浏览器工具整体不可用直到重启）。
 * 序号 ≤ 当前值视为重放拒绝；伪造序号过不了 MAC（序号参与 MAC 计算）。
 * main 侧在响应完成时同步赋号且 postMessage FIFO，完成序=到达序，单调接受不丢合法响应。
 */
export function classifyBrowserRpcResponse(
  sequence: number,
  macOk: boolean,
  inboundSequence: number
): "advance" | "reject-pending" {
  if (!macOk || sequence <= inboundSequence) return "reject-pending";
  return "advance";
}

export class BrowserRpcError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "BrowserRpcError";
    this.code = code;
  }
}

export function browserRpcErrorFromPayload(error: { code?: unknown; message?: unknown } | undefined): BrowserRpcError {
  const code = typeof error?.code === "string" && error.code ? error.code : "browser_internal_error";
  const message = typeof error?.message === "string" && error.message ? error.message : code;
  return new BrowserRpcError(code, message);
}

/**
 * 出站浏览器请求超时后的错误分类（#659）。
 *
 * policy:confirm / tab_browser_auth_request 等的是用户在 desktop 弹窗裁决：
 * 超时=用户未在时限内响应，动作必然未执行、弹窗仍开着。其余方法的请求已送达
 * desktop，变更型动作可能已执行——两类不能塌缩成同一错误码，否则对模型是
 * 双重误导（#606 review）：确认类误报"结果未知"诱导重试叠出第二个弹窗，
 * 变更类误报"未执行"诱导重复执行。
 */
export function classifyBrowserRequestTimeout(method: string): "confirmation_timeout" | "executed_unknown" {
  return method === "policy:confirm" || method === "tab_browser_auth_request"
    ? "confirmation_timeout"
    : "executed_unknown";
}
