/**
 * 运行时错误消息人性化层（#559）：内部错误码 / 组件名前缀在进入 run.failed、
 * 上屏与 IM 透传前改写为面向用户的可操作信息。纯函数、有序匹配，未命中的
 * 消息原样透传（仅剥内部前缀）。
 * 放置于 shared：packages/sdk 的 lifecycle-projector 流抛错终值出口与 sidecar
 * runner 各上屏面共用同一份映射（二轮 review P2——单源否则终值出口双标）。
 */

/** 兜底指引：无法识别的错误统一给出下一步 */
const FALLBACK_GUIDANCE = "执行失败，请稍后重试；若持续失败请到设置 → 诊断日志查看详情。";

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
  // 剥完只剩空壳（如裸的「Agent SDK 执行失败」），给兜底指引而非无因报错
  if (!normalized) return FALLBACK_GUIDANCE;

  for (const rule of RULES) {
    if (rule.match(normalized)) return rule.render(normalized);
  }
  return normalized;
}
