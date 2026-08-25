/**
 * IM 日志/错误文案脱敏（纯函数）。
 *
 * IM 出站错误常内嵌敏感凭证：钉钉 sessionWebhook 自带 access_token 查询参数、
 * 部分平台报错回显完整请求 URL 或 Authorization 头。这些字符串会进入
 * lastError 持久化与桌面端运行时事件，落盘前必须脱敏。
 */

/** 值疑似凭证的查询参数键名 */
const SENSITIVE_QUERY_KEYS = /(access[-_]?token|token|secret|sign(?:ature)?|key|webhook[-_]?url|corp ?id)/i;

/** 键名疑似凭证的 JSON/键值对形态："appSecret":"xxx" / token: xxx */
const SENSITIVE_KEY_VALUE =
  /((?:["']?(?:app[_-]?secret|client[_-]?secret|secret|access[_-]?token|api[_-]?key|token)["']?\s*[:=]\s*["']?))(?:bearer\s+)?([A-Za-z0-9._~+/=-]{8,})/gi;

function maskValue(value: string): string {
  if (value.length <= 6) return "***";
  return `${value.slice(0, 4)}***`;
}

export function redactSensitiveText(text: string): string {
  if (!text) return text;
  let out = text;
  // URL 查询参数中疑似凭证的值：?access_token=xxx&...
  out = out.replace(
    /([?&]([A-Za-z0-9_.-]+)=)([A-Za-z0-9._~-]{4,})/g,
    (match, prefix: string, key: string, value: string) =>
      SENSITIVE_QUERY_KEYS.test(key) ? `${prefix}${maskValue(value)}` : match
  );
  // Authorization 头（JSON 字符串/日志两种形态）
  out = out.replace(
    /(authorization"?\s*[:=]\s*"?)(?:bearer\s+)?([A-Za-z0-9._~+/=-]{8,})/gi,
    (_match, prefix: string) => `${prefix}***`
  );
  // 凭证类键的键值对任意形态：{"appSecret":"..."} / secret=...
  out = out.replace(SENSITIVE_KEY_VALUE, (_match, prefix: string, value: string) =>
    value.length <= 6 ? `${prefix}***` : `${prefix}${maskValue(value)}`
  );
  return out;
}

export function redactSensitiveError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message);
}
