/**
 * 出站 IM 文本分段：各渠道对单条消息有长度上限（企微 markdown 4096 字节、
 * 钉钉 webhook 数千字节、飞书文本保守 4000 字符），整条发送超限直接被拒
 * 且无自动分段（#405）。
 */

export interface ImSegmentLimit {
  /** 每段最大字符数 */
  maxChars?: number;
  /** 每段最大 UTF-8 字节数（多字节字符不跨段切分） */
  maxBytes?: number;
}

/** 按上限把长文本切段；不超限原样返回单段。空文本返回空数组由调用方兜底。 */
export function splitImMessage(text: string, limit: ImSegmentLimit): string[] {
  const maxChars = limit.maxChars ?? Number.MAX_SAFE_INTEGER;
  const maxBytes = limit.maxBytes ?? Number.MAX_SAFE_INTEGER;
  if (Buffer.byteLength(text, "utf8") <= maxBytes && text.length <= maxChars) {
    return [text];
  }

  const segments: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    // `for...of` yields whole code points; use the code point's UTF-16 width so
    // maxChars remains consistent with the fast-path `text.length` check.
    if (current && (current.length + char.length > maxChars || currentBytes + charBytes > maxBytes)) {
      segments.push(current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current) segments.push(current);
  return segments;
}

/** 单段发送结果；transient=true 表示瞬时失败（网络/超时），允许重发一次。 */
export interface SegmentSendResult {
  ok: boolean;
  error?: string;
  transient?: boolean;
}

/**
 * #598：分段逐段发送 + 瞬时错误一次重发 + 中途失败的「已送达 N/M 段」归因。
 * 确定性失败（业务拒绝/HTTP 4xx）不重发。
 */
export async function sendImSegments(
  segments: string[],
  sendOne: (segment: string) => Promise<SegmentSendResult>
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as string;
    let result = await sendOne(segment);
    if (!result.ok && result.transient) {
      result = await sendOne(segment);
    }
    if (!result.ok) {
      const suffix = segments.length > 1 ? `已送达 ${index}/${segments.length} 段，后续未送达：` : "";
      return { ok: false, error: `${suffix}${result.error ?? "发送失败"}` };
    }
  }
  return { ok: true };
}
