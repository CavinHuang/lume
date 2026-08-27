import { createLogger } from "../../infra/logger";

const log = createLogger("im-mirror-failure");

/** 平台侧与权限相关的错误码：出现即把技术错误串翻译成设置页可执行的指引。 */
const MIRROR_SCOPE_CODE_PATTERN = /\b(99991672|99991679)\b/;

/**
 * 把镜像写操作的失败信息转成设置页可读文案（#544「权限缺失明示」）。
 * 只做已有错误的映射，不做主动 scope 探测——试调建群等写 API 本身就有副作用。
 */
export function describeImMirrorFailure(error: unknown): string {
  const raw =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : String(error ?? "");
  const text = raw.trim();
  if (!text) return "";
  if (MIRROR_SCOPE_CODE_PATTERN.test(text)) {
    log.info("镜像写入命中权限类错误码，输出权限指引文案");
    return "缺少 im:chat / im:message.group_msg 权限，请在飞书开放平台为该应用开通后重试";
  }
  return text;
}
