export interface GmailMessageHeader {
  name: string;
  value: string;
}

export interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  headers?: GmailMessageHeader[];
  body?: {
    attachmentId?: string;
    data?: string;
    size?: number;
  };
  parts?: GmailMessagePart[];
}

export interface GmailMessageResource {
  id: string;
  threadId: string;
  historyId?: string;
  internalDate?: string;
  labelIds?: string[];
  snippet?: string;
  raw?: string;
  payload?: GmailMessagePart;
}

export interface GmailDraftResource {
  id: string;
  message: GmailMessageResource;
}

export interface GmailThreadResource {
  id: string;
  historyId?: string;
  snippet?: string;
  messages?: GmailMessageResource[];
}

export interface GmailAttachmentSummary {
  attachmentId: string | null;
  filename: string;
  mimeType: string;
  size: number;
}

export interface NormalizedGmailMessage {
  messageId: string;
  threadId: string;
  labelIds: string[];
  subject: string;
  sender: string;
  to: string;
  preview: {
    subject: string;
    body: string;
  };
  payload: GmailMessagePart | null;
  messageText: string;
  attachmentList: GmailAttachmentSummary[];
  messageTimestamp: string;
  raw?: string;
}

export interface GmailMessageSummary {
  messageId: string;
  threadId: string;
  labelIds: string[];
  subject: string;
  sender: string;
  to: string;
  messageTimestamp: string;
}

export interface MimeMessageInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  isHtml?: boolean;
  from?: string;
  inReplyTo?: string;
  references?: string;
}

export function summarizeGmailMessage(resource: GmailMessageResource): GmailMessageSummary {
  const headers = resource.payload?.headers ?? [];
  return {
    messageId: resource.id,
    threadId: resource.threadId,
    labelIds: resource.labelIds ?? [],
    subject: decodeMimeWords(readHeader(headers, "Subject")),
    sender: decodeMimeWords(readHeader(headers, "From")),
    to: decodeMimeWords(readHeader(headers, "To")),
    messageTimestamp: toMessageTimestamp(resource.internalDate, readHeader(headers, "Date")),
  };
}

/**
 * 工具输出的体积护栏:normalize 结果直通 LLM 上下文,一封带大附件的邮件其
 * payload 内联 base64 与整封 raw 就有数 MB,批量 fetch(maxResults≤500)会撑爆上下文。
 * 解码文本进 messageText(截断),附件元数据进 attachmentList,body.data/raw 纯属冗余。
 */
const MAX_MESSAGE_TEXT_CHARS = 20_000;
const MAX_RAW_CHARS = 20_000;

function stripInlineBase64(part: GmailMessagePart): GmailMessagePart {
  return {
    ...part,
    body: part.body ? { ...part.body, data: undefined } : undefined,
    parts: part.parts?.map((child) => stripInlineBase64(child)),
  };
}

export function normalizeGmailMessage(resource: GmailMessageResource): NormalizedGmailMessage {
  const payload = resource.payload ?? null;
  const summary = summarizeGmailMessage(resource);
  const fullBodyText = extractBodyContent(payload).body;
  const messageText =
    fullBodyText.length > MAX_MESSAGE_TEXT_CHARS
      ? `${fullBodyText.slice(0, MAX_MESSAGE_TEXT_CHARS)}…[truncated, total ${fullBodyText.length} chars]`
      : fullBodyText;

  return {
    ...summary,
    preview: {
      subject: summary.subject,
      body: resource.snippet ?? fullBodyText.slice(0, 200),
    },
    payload: payload ? stripInlineBase64(payload) : null,
    messageText,
    attachmentList: collectAttachments(payload),
    ...(resource.raw && resource.raw.length <= MAX_RAW_CHARS ? { raw: resource.raw } : {}),
  };
}

export function readHeader(headers: GmailMessageHeader[], name: string): string {
  return headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

const ENCODED_WORD = /\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g;

/** 单个编码词还原为原始字节:B 走 base64(带合法性校验),Q 走 _=空格/=XX=hex。 */
function encodedWordBytes(encoding: string, text: string): Buffer | null {
  if (encoding === "B" || encoding === "b") {
    const buffer = Buffer.from(text, "base64");
    // Node 的 base64 解码静默忽略非法字符:round-trip 不符或整体解空即视为畸形,
    // 与 Q 路径的回退语义对齐(原样保留比 mojibake 可诊断)
    const stripped = text.replace(/=+$/, "");
    if (buffer.toString("base64").replace(/=+$/, "") !== stripped || buffer.length === 0) {
      return null;
    }
    return buffer;
  }
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "_") {
      bytes.push(0x20);
    } else if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(index + 1, index + 3))) {
      bytes.push(parseInt(text.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      const code = text.charCodeAt(index);
      if (code > 0x7f) return null;
      bytes.push(code);
    }
  }
  return Buffer.from(bytes);
}

/**
 * RFC 2047 encoded-word 解码(仅收件方向展示):Gmail API 返回的 headers 是 MIME
 * 源码原值,中文主题形如 =?UTF-8?B?...?= 对模型不可读。仅解 UTF-8/ASCII 系,
 * 其余 charset 原样保留;发送侧编码见 encodeSubject(回复引用原样回填即合法)。
 *
 * 相邻编码词序列(RFC 2047 §6.2 允许编码器在 75 字符词界把多字节字符中切)
 * 先在字节层拼接再统一 UTF-8 解码——逐词独立解码必产 U+FFFD 花屏。
 */
export function decodeMimeWords(value: string): string {
  if (!value.includes("=?")) {
    return value;
  }
  return value.replace(
    /(?:=\?[^?\s]+\?[bBqQ]\?[^?]*\?=)(?:\s+=\?[^?\s]+\?[bBqQ]\?[^?]*\?=)*/g,
    (run) => {
      const words = [...run.matchAll(ENCODED_WORD)];
      // ENCODED_WORD 捕获组:[0]=全匹配,[1]=charset,[2]=encoding,[3]=text
      const decodable = words.every((word) => {
        const charset = (word[1] ?? "").toLowerCase();
        return charset === "utf-8" || charset === "utf8" || charset === "us-ascii";
      });
      if (!decodable) {
        return run;
      }
      const buffers: Buffer[] = [];
      for (const word of words) {
        const bytes = encodedWordBytes(word[2] as string, word[3] ?? "");
        if (!bytes) {
          return run;
        }
        buffers.push(bytes);
      }
      return Buffer.concat(buffers).toString("utf8");
    },
  );
}

export function resolveReplyHeaders(resource: GmailMessageResource): {
  subject: string;
  to: string;
  references: string;
  inReplyTo: string;
} {
  const headers = resource.payload?.headers ?? [];
  return {
    subject: normalizeReplySubject(readHeader(headers, "Subject")),
    to: firstAddress(readHeader(headers, "Reply-To")) || firstAddress(readHeader(headers, "From")),
    // RFC 5322 惯例:References = 父.References + " " + 父.Message-ID,多级线程链
    // 才不逐代断格。resource.id 是 Gmail 裸 id,不是合法 <angle@id> 形制,不作兜底;
    // 无 Message-ID 的消息(API 创建草稿常见)线程归组由发送时的 threadId 保证。
    references: [readHeader(headers, "References"), readHeader(headers, "Message-ID")]
      .filter(Boolean)
      .join(" "),
    inReplyTo: readHeader(headers, "Message-ID"),
  };
}

export function encodeMimeMessage(input: MimeMessageInput): string {
  const headers = [
    headerLine("From", joinAddresses(input.from ? [input.from] : [])),
    headerLine("To", joinAddresses(input.to)),
    headerLine("Cc", joinAddresses(input.cc ?? [])),
    headerLine("Bcc", joinAddresses(input.bcc ?? [])),
    headerLine("Subject", encodeSubject(input.subject ?? "")),
    headerLine("In-Reply-To", input.inReplyTo),
    headerLine("References", input.references),
    "MIME-Version: 1.0",
    `Content-Type: ${input.isHtml ? "text/html" : "text/plain"}; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
  ].filter(Boolean);

  const body = Buffer.from(input.body ?? "", "utf8").toString("base64");
  const raw = `${headers.join("\r\n")}\r\n\r\n${body}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

export function parseAddressList(value: string): string[] {
  const addresses: string[] = [];
  let current = "";
  let inQuotes = false;
  let angleDepth = 0;
  let escaped = false;

  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      current += char;
      if (inQuotes) {
        escaped = true;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }

    if (!inQuotes) {
      if (char === "<") {
        angleDepth += 1;
      } else if (char === ">" && angleDepth > 0) {
        angleDepth -= 1;
      } else if (char === "," && angleDepth === 0) {
        const address = current.trim();
        if (address) {
          addresses.push(address);
        }
        current = "";
        continue;
      }
    }

    current += char;
  }

  const address = current.trim();
  if (address) {
    addresses.push(address);
  }

  return addresses;
}

export function firstAddress(value: string): string {
  return parseAddressList(value)[0] ?? "";
}

export function extractBodyContent(payload: GmailMessagePart | null): {
  body: string;
  isHtml: boolean;
} {
  if (!payload) {
    return { body: "", isHtml: false };
  }

  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return {
      body: decodeBase64Url(payload.body.data),
      isHtml: false,
    };
  }

  if (payload.mimeType === "text/html" && payload.body?.data) {
    return {
      body: decodeBase64Url(payload.body.data),
      isHtml: true,
    };
  }

  for (const part of payload.parts ?? []) {
    const content = extractBodyContent(part);
    if (content.body) {
      return content;
    }
  }

  if (payload.body?.data && (!payload.mimeType || payload.mimeType.startsWith("text/"))) {
    return {
      body: decodeBase64Url(payload.body.data),
      isHtml: payload.mimeType === "text/html",
    };
  }

  return { body: "", isHtml: false };
}

export function normalizeThreadId(value: unknown): string {
  return String(value ?? "")
    .replace(/^thread-f:/i, "")
    .replace(/^msg-f:/i, "")
    .trim();
}

export function normalizeMessageId(value: unknown): string {
  return String(value ?? "").trim();
}

interface RecipientsInput {
  to?: unknown;
  recipientEmail?: unknown;
  extraRecipients?: unknown;
  cc?: unknown;
  bcc?: unknown;
}

interface Recipients {
  to: string[];
  cc: string[];
  bcc: string[];
}

export function buildRecipients(input: RecipientsInput): Recipients {
  const primaryTo = optionalAddressList(input.to);
  const recipientEmail = optionalAddressList(input.recipientEmail);
  const extraRecipients = optionalAddressList(input.extraRecipients);

  return {
    to: [...primaryTo, ...recipientEmail, ...extraRecipients],
    cc: optionalAddressList(input.cc),
    bcc: optionalAddressList(input.bcc),
  };
}

function collectAttachments(payload: GmailMessagePart | null): GmailAttachmentSummary[] {
  if (!payload) {
    return [];
  }

  const attachments: GmailAttachmentSummary[] = [];
  if (payload.filename) {
    attachments.push({
      attachmentId: payload.body?.attachmentId ?? null,
      filename: payload.filename,
      mimeType: payload.mimeType ?? "application/octet-stream",
      size: payload.body?.size ?? 0,
    });
  }

  for (const part of payload.parts ?? []) {
    attachments.push(...collectAttachments(part));
  }

  return attachments;
}

function decodeBase64Url(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function toMessageTimestamp(internalDate?: string, fallbackDate?: string) {
  if (internalDate) {
    const parsed = Number(internalDate);
    if (Number.isFinite(parsed)) {
      const date = new Date(parsed);
      if (!Number.isNaN(date.getTime())) {
        return date.toISOString();
      }
    }
  }

  if (fallbackDate) {
    const parsed = new Date(fallbackDate);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return "";
}

function normalizeReplySubject(subject: string) {
  if (!subject) {
    return "Re:";
  }

  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

function encodeSubject(subject: string) {
  return subject.split("").every((char) => char.charCodeAt(0) <= 0x7f)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

function joinAddresses(addresses: string[]) {
  return addresses.filter(Boolean).join(", ");
}

function headerLine(name: string, value?: string) {
  // Strip CR/LF so hostile tool input (e.g. a prompt-injected recipient or
  // subject) cannot smuggle extra MIME headers — Bcc, Subject, etc. — into the
  // raw message sent to the Gmail API.
  const sanitized = value?.replace(/\r\n?|\n/g, " ");
  return sanitized ? `${name}: ${sanitized}` : "";
}

function optionalAddressList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  const stringValue = String(value ?? "").trim();
  return stringValue ? [stringValue] : [];
}
