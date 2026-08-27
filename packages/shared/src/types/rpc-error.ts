/**
 * 跨进程 RPC 错误契约(#579)。
 *
 * sidecar 出站与 desktop 入站统一消费此形状：既有 Error 子类的 `name`
 * 与 `connection_*` 式字符串码经 duck-typing 提取后获得跨进程生存权，
 * 消除"desktop 只能字符串匹配猜错误类别"的根因。
 *
 * 已知缺口(review 定性):code 目前只贯通到 desktop main 进程;renderer 经
 * ipcRenderer.invoke 取回的错误被 Electron 平台序列化剥掉自定义属性,仍靠
 * message 判别。贯通 renderer 需在 ipc 边界显式序列化 {code,message},另行承接。
 */

export interface LumeRpcErrorShape {
  code: string;
  message: string;
  /**
   * 仅在 throw 值显式携带时透传,无服务端白名单/截断——填充方须自行保证
   * 不含敏感内容(内部绝对路径/凭证/env 片段)。
   */
  details?: unknown;
}

/**
 * 稳定跨进程错误码。覆盖 #579 契约落地后**新增**的显式 code——存量手写 shape
 * 码(E_NOT_IMPLEMENTED/connection_* 等)仍在各自定义点,待统一批迁再入账,
 * 本表暂不作唯一事实源承诺,新增业务 code 一律在此登记,勿依赖 name 兜底值。
 */
export const RPC_ERROR_CODES = {
  /** 入参校验失败(validateInput) */
  INVALID_PARAMS: "E_INVALID_PARAMS",
  /** 无更具体语义时的兜底码(desktop 侧约定不附着到 rejection) */
  RPC: "E_RPC",
} as const;

/**
 * 从任意 throw 值提取稳定错误形状（不建 Error 类层级）：
 * 显式 `code` 优先，其次非泛型 `name`（Error 子类），兜底 `E_RPC`。
 *
 * 注意:`name` 兜底系过渡态——类名即成为跨进程 code,重命名类会静默变更
 * 该错误族的对外标识(TypeError/ZodError 直抛亦然);消费方勿依赖具体
 * name 码判别,新增错误一律显式携带 `code`。
 *
 * details 透传的填充方责任除内容安全外还包括**可 JSON 序列化**(BigInt/
 * circular/抛错的 toJSON 会让整条错误响应 stringify 失败)——当前出站路径
 * 无序列化兜底,不可序列化的 details 等于丢弃整个错误响应。
 */
export function toLumeRpcErrorShape(error: unknown): LumeRpcErrorShape {
  const source = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const code =
    typeof source.code === "string" && source.code
      ? source.code
      : typeof source.name === "string" && source.name && source.name !== "Error"
        ? source.name
        : RPC_ERROR_CODES.RPC;
  const message = typeof source.message === "string" && source.message ? source.message : String(error);
  return {
    code,
    message,
    ...(source.details !== undefined ? { details: source.details } : {}),
  };
}
