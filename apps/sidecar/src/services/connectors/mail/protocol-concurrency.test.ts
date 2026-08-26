import { describe, expect, it } from "bun:test";
import { createMailProtocol, maxImapConnectionsPerAccount, type MailCredential } from "./protocol";

/**
 * 回归钉死 #698:协议层一动作一连接,agent 并行只读工具会同时开多条 IMAP
 * 连接撞服务商单账号上限(QQ 超限报 LOGIN failed 又被误判成授权码失效)。
 * 按账号闸门必须把同账号在途连接压到 maxImapConnectionsPerAccount 之下,
 * 且不同账号互不牵连。
 */
function makeTrackingFactory() {
  let live = 0;
  let peak = 0;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
  return {
    get peak() {
      return peak;
    },
    createImapClient: () => {
      live += 1;
      peak = Math.max(peak, live);
      return {
        connect: async () => {
          await tick();
        },
        logout: async () => {
          live -= 1;
        },
        close: () => {},
        list: async () => [],
        status: async () => ({ messages: 1 }),
      };
    },
  };
}

function credential(email: string): MailCredential {
  return { email, authorizationCode: "abcd1234efgh5678", imapHost: "imap.qq.com", smtpHost: "smtp.qq.com" };
}

// 并发闸门测试与连接期 host-pinning 无关:显式豁免避免默认 pinning 触发真实 DNS
const config = { displayName: "QQ 邮箱", attachmentFallbackPrefix: "attachment", enforceHostNetworkPolicy: false };

describe("per-account IMAP connection gate (#698)", () => {
  it("caps concurrent connections for one account while keeping all calls successful", async () => {
    const fake = makeTrackingFactory();
    const protocol = createMailProtocol(config, fake);

    const results = await Promise.all(
      Array.from({ length: 6 }, () => protocol.getFolderStatus(credential("user@qq.com"), "INBOX")),
    );

    expect(results).toHaveLength(6);
    expect(fake.peak).toBe(maxImapConnectionsPerAccount);
  });

  it("tracks accounts independently so one busy mailbox never blocks another", async () => {
    const fake = makeTrackingFactory();
    const protocol = createMailProtocol(config, fake);

    await Promise.all([
      ...Array.from({ length: 3 }, () => protocol.getFolderStatus(credential("a@qq.com"), "INBOX")),
      ...Array.from({ length: 3 }, () => protocol.getFolderStatus(credential("b@qq.com"), "INBOX")),
    ]);

    expect(fake.peak).toBe(maxImapConnectionsPerAccount * 2);
  });
});
