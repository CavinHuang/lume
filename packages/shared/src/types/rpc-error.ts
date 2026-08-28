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
 * 稳定跨进程错误码台账。当前收敛范围:RPC 传输协议层(E_* 分帧/解析/分派/
 * 入参校验)、
 * desktop 启动关键路径密钥注入与 browser 通道可用性三类 sidecar 出站位点;
 * 业务域 handler 合成的错误形状(MCP/插件市场/连接器等)仍在各自定义点,
 * 按域渐进收编。新增出站 code 一律在此登记;勿依赖 name 兜底值。
 */
export const RPC_ERROR_CODES = {
  /** 入参校验失败(validateInput) */
  INVALID_PARAMS: "E_INVALID_PARAMS",
  /** 无更具体语义时的兜底码(desktop 侧约定不附着到 rejection) */
  RPC: "E_RPC",
  /** RPC 消息超出尺寸上限(process-transport 分帧) */
  MESSAGE_TOO_LARGE: "E_MESSAGE_TOO_LARGE",
  /** RPC 帧行非合法 JSON */
  BAD_JSON: "E_BAD_JSON",
  /** RPC 帧结构非法(method/params 缺失等) */
  BAD_REQUEST: "E_BAD_REQUEST",
  /** 未注册的 method */
  NOT_IMPLEMENTED: "E_NOT_IMPLEMENTED",
  /** 连接凭证库密钥注入被拒(desktop 启动关键路径) */
  CONNECTION_VAULT_KEY_INVALID: "connection_vault_key_invalid",
  /** 密文加密密钥注入被拒(desktop 启动关键路径) */
  SECRET_ENCRYPTION_KEY_INVALID: "secret_encryption_key_invalid",
  /** desktop 浏览器主进程通道断开/不可用。与 shared browser-runtime.ts 的 BrowserErrorCode "browser_unavailable" 同字符串双域,改须核对彼侧白名单 */
  BROWSER_UNAVAILABLE: "browser_unavailable",

  // ---- 业务码族(#793② 渐进收编,第二批):MCP/插件/连接器/通知域出站位点 ----
  /** MCP 授权缺失,需用户重新完成 OAuth(workspace-mcp-manager) */
  MCP_AUTH_NEEDED: "auth_needed",
  /** MCP stdio 进程拉起失败(workspace-mcp-manager) */
  MCP_SPAWN_FAILED: "spawn_failed",
  /** MCP 远程传输连接失败(workspace-mcp-manager) */
  MCP_CONNECTION_FAILED: "connection_failed",
  /** MCP SDK 错误兜底(workspace-mcp-manager) */
  MCP_ERROR: "mcp_error",
  /** MCP server 资源不存在(PublicMcpError,workspace-mcp-manager) */
  MCP_NOT_FOUND: "not_found",
  /** 插件 manifest 校验失败(agent-runtime/plugins/capability-resolver) */
  PLUGIN_INVALID_MANIFEST: "invalid_manifest",
  /** 连接器动作未注册(connectors/service) */
  CONNECTOR_ACTION_UNKNOWN: "action_unknown",
  /** 连接器入参不合法(providers/provider-runtime) */
  CONNECTOR_INVALID_INPUT: "invalid_input",
  /** 连接器内部错误兜底(providers/provider-runtime) */
  CONNECTOR_INTERNAL_ERROR: "internal_error",
  /** 通知 run.failed 合成错误(agent-notification-service) */
  NOTIFICATION_RUNTIME_ERROR: "runtime_error",
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
