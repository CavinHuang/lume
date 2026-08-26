/**
 * 跨进程 RPC 错误契约(#579)。
 *
 * sidecar 出站与 desktop 入站统一消费此形状：既有 Error 子类的 `name`
 * 与 `connection_*` 式字符串码经 duck-typing 提取后获得跨进程生存权，
 * 消除"desktop 只能字符串匹配猜错误类别"的根因。
 */

export interface LumeRpcErrorShape {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * 从任意 throw 值提取稳定错误形状（不建 Error 类层级）：
 * 显式 `code` 优先，其次非泛型 `name`（Error 子类），兜底 `E_RPC`。
 */
export function toLumeRpcErrorShape(error: unknown): LumeRpcErrorShape {
  const source = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const code =
    typeof source.code === "string" && source.code
      ? source.code
      : typeof source.name === "string" && source.name && source.name !== "Error"
        ? source.name
        : "E_RPC";
  const message = typeof source.message === "string" && source.message ? source.message : String(error);
  return { code, message };
}
