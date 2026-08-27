/**
 * 运行时错误消息人性化层（#559）：内部错误码 / 组件名前缀在进入 run.failed、
 * 上屏与 IM 透传前改写为面向用户的可操作信息。纯函数、有序匹配，未命中的
 * 消息原样透传（仅剥内部前缀）。
 * 放置于 shared：packages/sdk 的 lifecycle-projector 流抛错终值出口与 sidecar
 * runner 各上屏面共用同一份映射（二轮 review P2——单源否则终值出口双标）。
 */

/** 兜底指引：无法识别的错误统一给出下一步 */
const FALLBACK_GUIDANCE = "执行失败，请稍后重试；若持续失败请到设置 → 诊断日志查看详情。";

/**
 * 工具权限中断哨兵（single-source）：sidecar 以这两前缀收口 deny/超时消息
 * （can-use-tool.ts），web 端横幅摘除与超时投影据此文本判定；humanize 层对
 * 含哨兵的消息保持原文透传——文本本身是跨包契约，改动须三端同步（#559 收尾）。
 * 存量 run items 无法补结构化 code，故文本匹配是新旧数据通吃的判定面。
 */
export const TOOL_PERMISSION_TIMEOUT_PREFIX = "工具权限确认超时";
export const USER_DENIED_TOOL_PREFIX = "用户拒绝执行工具";

/** 工具被「确认超时」或「用户拒绝」收口的中断类消息 */
export function isToolPermissionInterruptionMessage(message: string): boolean {
  return message.includes(TOOL_PERMISSION_TIMEOUT_PREFIX) || message.includes(USER_DENIED_TOOL_PREFIX);
}

interface ErrorCopyRule {
  match: (raw: string) => boolean;
  /** 收到原始消息，返回改写后的用户文案 */
  render: (raw: string) => string;
}

const RULES: ErrorCopyRule[] = [
  {
    // 渠道层 snake_case 错误码 → 人话 + 下一步（connection-provider.ts 抛出）
    match: (raw) => raw === "connection_disabled" || raw.startsWith("connection_disabled "),
    render: () => "该渠道已被停用。请到设置 → 连接配置启用渠道后重试。",
  },
  {
    match: (raw) => raw === "connection_api_key_unavailable" || raw.startsWith("connection_api_key_unavailable "),
    render: () => "渠道没有可用的 API Key。请到设置 → 连接配置补全后重试。",
  },
  {
    // 冒号/空白/结尾为界——兼容 #595 降级消息的「码: 细节」形态,不误伤连字符标识
    match: (raw) => /^connection_oauth_credential_unavailable(?::|\s|$)/u.test(raw),
    render: () => "订阅账号凭据不可用（可能已过期或被吊销）。请到设置 → 连接配置重新登录授权。",
  },
  {
    match: (raw) => raw === "connection_model_disabled" || raw.startsWith("connection_model_disabled "),
    render: () => "所选模型已在渠道中停用。请到设置 → 连接配置启用该模型或更换模型。",
  },
  {
    // fallback 重试链耗尽（pi-ai routing）不改写原因，只给可动作指引
    match: (raw) => raw.includes("routing exhausted"),
    render: () => "所有可用渠道都尝试失败。请检查网络与渠道配置后重试；若使用多个渠道，可在设置中调整回退顺序。",
  },
];

/** 内部组件名前缀：对用户无信息量，剥掉后展示剩余原因 */
const INTERNAL_PREFIXES = [
  /^Agent Runtime 执行失败[:：]\s*/u,
  /^Agent SDK 执行失败[:：]\s*/u,
  /^Agent SDK 执行失败\s*$/u,
  // review F4:带词边界,不误伤 runtime-core-xxx 这类以它为前缀的其他标识
  /^runtime-core(?::|\s|$)\s*/u,
];

export function humanizeRuntimeErrorMessage(message: string): string {
  const raw = message.trim();
  if (!raw || raw === "Unknown sidecar error" || raw === "未知错误")
    return FALLBACK_GUIDANCE;

  // review P0:先剥内部前缀再跑规则——attempt 补发出口的实际输入是
  // 「Agent Runtime 执行失败: connection_disabled」这类组合形态,
  // 若先匹配 RULES 则带前缀形态永不命中,裸码会透出上屏。
  let stripped = raw;
  for (const prefix of INTERNAL_PREFIXES) {
    stripped = stripped.replace(prefix, "");
  }
  const normalized = stripped.trim();
  // 剥完只剩空壳（如裸的「Agent SDK 执行失败」），给兜底指引而非无因报错。
  // 三轮 review F1:「前缀+未知错误」组合形态剥完剩字面量,同样落兜底。
  if (!normalized || normalized === "未知错误") return FALLBACK_GUIDANCE;

  for (const rule of RULES) {
    if (rule.match(normalized)) return rule.render(normalized);
  }
  return normalized;
}
