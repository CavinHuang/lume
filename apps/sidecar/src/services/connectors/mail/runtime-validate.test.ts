import { describe, expect, it, mock } from "bun:test";

/**
 * 钉死 validateMailCredential 四路径与 #735 核心接线(#735 二轮审查 P2:
 * 重构后的预算→AbortController→排队中止链路此前零直接测试)。
 * mock 必须枚举 ./config 全量具名导出(bun mock 坑:缺失具名导出 CI 上抛错),
 * 预算常量缩到测试量级才能在毫秒级钉住超时路径。
 */
mock.module("./config", () => ({
  mailImapPort: 993,
  mailSmtpPort: 465,
  mailMessageFetchByteLimit: 1024,
  mailAttachmentDownloadByteLimit: 1024,
  mailConnectionTimeoutMs: 1000,
  mailValidationTotalBudgetMs: 60,
}));

type ImapValidate = (signal?: AbortSignal) => Promise<void>;
let imapValidate: ImapValidate = async () => {};
let smtpValidate: () => Promise<void> = async () => {};

mock.module("./protocol", () => ({
  createMailProtocol: () => ({
    validateImapCredential: (_credential: unknown, signal?: AbortSignal) => imapValidate(signal),
    validateSmtpCredential: () => smtpValidate(),
  }),
}));

const { createMailProviderRuntime } = await import("./runtime");
const { MailProtocolError } = await import("./errors");

const values = {
  email: "user@qq.com",
  authorizationCode: "abcd1234efgh5678",
  imapHost: "imap.qq.com",
  smtpHost: "smtp.qq.com",
};

const config = {
  service: "qq_mail",
  displayName: "QQ 邮箱",
  attachmentFallbackPrefix: "attachment",
  connectAuthMessage: "connect auth failed",
  // 单一固定凭证:直接从闭包展开,绕开 Record 索引访问的 undefined 放宽
  readCredential: () => ({ ...values }),
};

const { credentialValidators } = createMailProviderRuntime(config);

const validate = () => {
  const custom = credentialValidators.customCredential;
  if (!custom) {
    throw new Error("expected a custom credential validator");
  }
  return custom({ values }, {} as never);
};

describe("validateMailCredential wiring (#735)", () => {
  it("returns the lowercased account profile on success", async () => {
    const result = await validate();
    if (!result) {
      throw new Error("expected a validation result");
    }
    expect(result.profile?.accountId).toBe("user@qq.com");
    expect(result.metadata?.imapHost).toBe("imap.qq.com");
  });

  it("maps an imap failure to the provider-specific connect message", async () => {
    imapValidate = () => Promise.reject(new MailProtocolError("auth", "LOGIN failed"));
    smtpValidate = async () => {};
    await expect(validate()).rejects.toMatchObject({ status: 400, message: "connect auth failed" });
  });

  it("restates smtp failures with the failing endpoint", async () => {
    imapValidate = async () => {};
    smtpValidate = () => Promise.reject(new MailProtocolError("network", "ECONNREFUSED"));
    await expect(validate()).rejects.toMatchObject({
      status: 502,
      message: "ECONNREFUSED (SMTP smtp.qq.com:465)",
    });
  });

  it("settles at 504 on budget expiry and aborts the still-running imap validation", async () => {
    let sawAbort = false;
    imapValidate = (signal) =>
      new Promise<void>((_, reject) => {
        signal?.addEventListener("abort", () => {
          sawAbort = true;
          reject(signal.reason);
        });
      });
    await expect(validate()).rejects.toMatchObject({
      status: 504,
      message: "QQ 邮箱 connection test budget exceeded",
    });
    // 预算定时器兼任取消信号:abort 确实传导到了 IMAP 阶段(排队中止接线的载荷行)
    expect(sawAbort).toBe(true);
  });
});
