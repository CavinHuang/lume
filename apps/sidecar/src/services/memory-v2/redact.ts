/**
 * 记忆链路共享的密钥检测与证据原文脱敏（#449）。
 * statement 与 evidence_refs[].quote 是两条独立的落盘通道：statement 在
 * remember 入口过滤，quote 原文由 markdown-store 写 frontmatter 前在此统一过滤。
 */

export const EVIDENCE_QUOTE_REDACTED = "[证据原文含疑似密钥，已省略]";

export function containsSecret(content: string): boolean {
  return /(?:api[_-]?key|token|password|密码|验证码|secret)\s*[:=]\s*\S+|\bsk-[A-Za-z0-9_-]{16,}\b/i.test(content)
    || /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}\b/.test(content)
    || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(content)
    || /\bAKIA[0-9A-Z]{16}\b/.test(content)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content)
    || /\bBearer\s+eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./i.test(content)
    || /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/.test(content);
}

/** 证据原文先过密钥过滤：整条源消息 quote 会明文进 frontmatter 并经 memory.read 回吐 prompt（#408/#449）。 */
export function redactEvidenceQuote(quote: string | undefined): string | undefined {
  if (!quote) return undefined;
  return containsSecret(quote) ? EVIDENCE_QUOTE_REDACTED : quote;
}
