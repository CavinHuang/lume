import { describe, expect, it } from "bun:test";
import { encodeMimeMessage } from "./message";

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
