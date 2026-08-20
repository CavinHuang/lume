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
