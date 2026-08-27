import { describe, expect, it } from "bun:test";
import { mapProtocolError, type MailRuntimeConfig } from "./runtime";
import { MailProtocolError } from "./errors";
import { ProviderRequestError } from "../providers/provider-runtime";

/**
 * 钉死协议错误 → HTTP 语义的映射表(#735 二轮审查:auth/busy 分支此前零覆盖)。
 * 模型按 code 字符串选自纠策略:busy 必须 429(退避重试)而非 502(上游故障),
 * auth 文案不得把用户径直引向重置授权码(#698)。
 */
const config: MailRuntimeConfig = {
  service: "qq_mail",
  displayName: "QQ 邮箱",
  attachmentFallbackPrefix: "attachment",
  connectAuthMessage: "connect auth failed",
  readCredential: () => {
    throw new Error("not used in mapping tests");
  },
};

const protocolError = (kind: string, message: string) => new MailProtocolError(kind as never, message);

describe("mapProtocolError maps kinds to HTTP semantics", () => {
  it.each([
    ["trash_missing", 400],
    ["blocked_host", 400],
    ["timeout", 504],
    ["network", 502],
    ["provider", 502],
  ] as const)("maps %s to %i with the original message", (kind, status) => {
    const mapped = mapProtocolError(protocolError(kind, "boom"), "execute", config);
    expect(mapped.status).toBe(status);
    expect(mapped.message).toBe("boom");
  });

  it.each(["folder_not_found", "uid_not_found"] as const)("maps %s to 400 with generic copy", (kind) => {
    const mapped = mapProtocolError(protocolError(kind, "boom"), "execute", config);
    expect(mapped.status).toBe(400);
    // 这两类不透传库错误原文,统一为可向模型呈现的通用文案
    expect(mapped.message).toContain("QQ 邮箱");
    expect(mapped.message).not.toBe("boom");
  });

  it("maps busy to 429 rate-limit semantics, not an upstream failure", () => {
    const execute = mapProtocolError(protocolError("busy", "Too many pending operations"), "execute", config);
    expect(execute.status).toBe(429);
    expect(execute.message).toContain("Too many pending operations");
  });

  it("keeps auth on 401 with a soft copy that does not push straight to resetting the code", () => {
    const execute = mapProtocolError(protocolError("auth", "LOGIN failed"), "execute", config);
    expect(execute.status).toBe(401);
    // 并列「凭证失效重连」与「临时限流重试」两种可能,而非断言凭证失效
    expect(execute.message).toContain("throttling");
    expect(execute.message).toContain("reconnect");
  });

  it("uses the provider-specific connect message for auth during credential validation", () => {
    const connect = mapProtocolError(protocolError("auth", "LOGIN failed"), "connect", config);
    expect(connect.status).toBe(400);
    expect(connect.message).toBe(config.connectAuthMessage);
  });

  it("passes through ProviderRequestError untouched and wraps unknown errors as 502", () => {
    const original = new ProviderRequestError(418, "already shaped");
    expect(mapProtocolError(original, "execute", config)).toBe(original);

    const wrapped = mapProtocolError(new Error("socket exploded"), "execute", config);
    expect(wrapped.status).toBe(502);
    expect(wrapped.message).toBe("socket exploded");

    const nonError = mapProtocolError("string error", "execute", config);
    expect(nonError.status).toBe(502);
    expect(nonError.message).toBe("QQ 邮箱 provider error.");
  });
});
