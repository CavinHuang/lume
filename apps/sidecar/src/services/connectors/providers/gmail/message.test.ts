import { describe, expect, it } from "bun:test";
import {
  decodeMimeWords,
  encodeMimeMessage,
  normalizeGmailMessage,
  summarizeGmailMessage,
  type GmailMessageResource,
} from "./message";

function decodeRaw(input: Parameters<typeof encodeMimeMessage>[0]): string {
  return Buffer.from(encodeMimeMessage(input), "base64url").toString("utf8");
}

describe("encodeMimeMessage header injection", () => {
  it("does not let a CRLF-bearing recipient smuggle extra headers", () => {
    const raw = decodeRaw({
      to: ["a@b.com\r\nBcc: attacker@evil.com\r\nSubject: pwned"],
      subject: "hi",
      body: "hello",
    });

    expect(raw).not.toContain("\nBcc:");
    expect(raw).not.toContain("\r\nSubject: pwned");
    expect(raw).toContain("To: a@b.com Bcc: attacker@evil.com Subject: pwned");
    expect(raw).toContain("Subject: hi");
  });

  it("strips bare-LF injection in subject and in-reply-to as well", () => {
    const raw = decodeRaw({
      to: ["safe@example.com"],
      subject: "x\nIn-Reply-To: <fake@evil.com>",
      inReplyTo: "orig@example.com\nReferences: <spoof@evil.com>",
      body: "hello",
    });

    expect(raw).not.toContain("\nIn-Reply-To: <fake@evil.com>");
    expect(raw).not.toContain("\nReferences: <spoof@evil.com>");
  });
});

describe("normalizeGmailMessage payload size guard", () => {
  const baseResource: GmailMessageResource = {
    id: "msg-1",
    threadId: "thread-1",
    snippet: "short snippet",
    payload: {
      mimeType: "multipart/mixed",
      headers: [{ name: "Subject", value: "hi" }],
      body: {},
      parts: [
        { mimeType: "text/plain", body: { data: Buffer.from("hello body").toString("base64url"), size: 10 } },
        {
          mimeType: "multipart/alternative",
          parts: [{ mimeType: "application/pdf", filename: "big.bin", body: { attachmentId: "att-1", data: "AAAA", size: 999999 } }],
        },
      ],
    },
  };

  it("strips inline base64 from nested payload but keeps structure metadata", () => {
    const normalized = normalizeGmailMessage(baseResource);

    const serialized = JSON.stringify(normalized.payload);
    expect(serialized).not.toContain("data");
    // 结构信息保留:messageText 已是解码文本,附件清单单独收集
    expect(normalized.messageText).toBe("hello body");
    expect(normalized.attachmentList).toEqual([
      { attachmentId: "att-1", filename: "big.bin", mimeType: "application/pdf", size: 999999 },
    ]);
  });

  it("truncates oversized message text with an explicit marker", () => {
    const huge = "x".repeat(25_000);
    const resource: GmailMessageResource = {
      ...baseResource,
      payload: { mimeType: "text/plain", body: { data: Buffer.from(huge, "utf8").toString("base64url") } },
    };

    const normalized = normalizeGmailMessage(resource);

    expect(normalized.messageText.startsWith("x".repeat(20_000))).toBe(true);
    expect(normalized.messageText).toContain("[truncated");
    expect(normalized.messageText.length).toBeLessThan(huge.length);
  });

  it("drops raw when it exceeds the size cap", () => {
    const normalized = normalizeGmailMessage({ ...baseResource, raw: "r".repeat(30_000) });
    expect(normalized.raw).toBeUndefined();

    const small = normalizeGmailMessage({ ...baseResource, raw: "small" });
    expect(small.raw).toBe("small");
  });
});

describe("decodeMimeWords (RFC 2047 inbound display)", () => {
  it("decodes UTF-8 B and Q encoded words", () => {
    const b = Buffer.from("你好,世界").toString("base64");
    expect(decodeMimeWords(`=?UTF-8?B?${b}?=`)).toBe("你好,世界");
    // Q 编码:_ 即空格,=XX hex
    expect(decodeMimeWords("=?utf-8?Q?Hello_=E4=BD=A0=E5=A5=BD?= there")).toBe("Hello 你好 there");
  });

  it("folds whitespace between adjacent encoded words", () => {
    const part = Buffer.from("世界").toString("base64");
    expect(decodeMimeWords(`Re: =?UTF-8?B?${part}?= =?UTF-8?B?${part}?=`)).toBe("Re: 世界世界");
  });

  it("keeps non-UTF-8 charsets and plain text untouched", () => {
    const raw = "=?gb2312?B?xOO6ww==?= plain";
    expect(decodeMimeWords(raw)).toBe(raw);
    expect(decodeMimeWords("no encoding here")).toBe("no encoding here");
  });

  it("summarizeGmailMessage decodes subject for display while reply headers stay raw", () => {
    const encodedSubject = `=?UTF-8?B?${Buffer.from("会议纪要").toString("base64")}?=`;
    const resource: GmailMessageResource = {
      id: "m1",
      threadId: "t1",
      payload: { headers: [{ name: "Subject", value: encodedSubject }] },
    };
    expect(summarizeGmailMessage(resource).subject).toBe("会议纪要");
  });
});
