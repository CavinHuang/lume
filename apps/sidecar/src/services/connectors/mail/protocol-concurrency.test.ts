import { describe, expect, it } from "bun:test";
import {
  createMailProtocol,
  imapAccountGateStateForTest,
  maxImapConnectionsPerAccount,
  type MailCredential,
} from "./protocol";

/**
 * 回归钉死 #698:协议层一动作一连接,agent 并行只读工具会同时开多条 IMAP
 * 连接撞服务商单账号上限(QQ 超限报 LOGIN failed 又被误判成授权码失效)。
 * 按账号闸门必须把同账号在途连接压到 maxImapConnectionsPerAccount 之下,
 * 且不同账号互不牵连、错误路径照常归还名额。
 */
interface TrackingFactoryOptions {
  /** 让 connect() 失败指定次数后恢复,覆盖「建连失败走 close 兜底」的名额归还分支。 */
  failConnectTimes?: number;
}

function makeTrackingFactory(options: TrackingFactoryOptions = {}) {
  let live = 0;
  let peak = 0;
  let connectFailuresLeft = options.failConnectTimes ?? 0;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
  return {
    get peak() {
      return peak;
    },
    createImapClient: () => {
      live += 1;
      peak = Math.max(peak, live);
      // 与 openAndRunImapClient 的双出口对齐:logout 成功与失败回退 close
      // 都只允许归还一次计数,否则错误用例的峰值统计失真
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          live -= 1;
        }
      };
      return {
        connect: async () => {
          await tick();
          if (connectFailuresLeft > 0) {
            connectFailuresLeft -= 1;
            throw new Error("LOGIN failed (AUTHENTICATIONFAILED)");
          }
        },
        logout: async () => {
          release();
        },
        close: () => {
          release();
        },
        list: async () => [],
        mailboxOpen: async () => ({}),
        search: async () => [1],
        fetchAll: async () => [],
        fetchOne: async () => false,
        messageFlagsAdd: async () => true,
        messageFlagsRemove: async () => true,
        messageMove: async () => ({ path: "target" }),
        messageDelete: async () => true,
        status: async () => ({ messages: 1 }),
        download: async () => ({ meta: {}, content: [] }),
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
    // 结果完整穿过闸门返回,而非仅 promise settle
    expect(results.every((result) => result.messages === 1)).toBe(true);
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

  it("merges letter-case variants of one address into the same gate", async () => {
    const fake = makeTrackingFactory();
    const protocol = createMailProtocol(config, fake);

    await Promise.all([
      protocol.getFolderStatus(credential("User@QQ.com"), "INBOX"),
      protocol.getFolderStatus(credential("user@qq.com"), "INBOX"),
      protocol.getFolderStatus(credential("USER@QQ.COM"), "INBOX"),
    ]);

    // 若大小写变体各开一闸,三路直入会把峰值推到 3
    expect(fake.peak).toBe(maxImapConnectionsPerAccount);
  });

  it("releases slots when connect fails so the account does not dead-lock", async () => {
    const fake = makeTrackingFactory({ failConnectTimes: 6 });
    const protocol = createMailProtocol(config, fake);

    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, () => protocol.getFolderStatus(credential("user@qq.com"), "INBOX")),
    );

    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    // 名额未被失败吞掉:后续调用仍能拿到连接并成功返回
    await expect(protocol.getFolderStatus(credential("user@qq.com"), "INBOX")).resolves.toMatchObject({
      messages: 1,
    });
    expect(fake.peak).toBe(maxImapConnectionsPerAccount);
  });

  it("keeps the gate healthy when actions reject mid-flight", async () => {
    const fake = makeTrackingFactory();
    const protocol = createMailProtocol(config, fake);

    const outcomes = await Promise.allSettled([
      ...Array.from({ length: 2 }, () => protocol.deleteMessage(credential("user@qq.com"), "INBOX", 999)),
      ...Array.from({ length: 4 }, () => protocol.getFolderStatus(credential("user@qq.com"), "INBOX")),
    ]);

    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    expect(rejected).toHaveLength(2);
    expect(fulfilled).toHaveLength(4);
    for (const outcome of rejected) {
      expect(outcome.reason).toMatchObject({ kind: "uid_not_found" });
    }
    expect(fake.peak).toBe(maxImapConnectionsPerAccount);
    // 失败路径归还名额后,账号照常可用
    await expect(protocol.getFolderStatus(credential("user@qq.com"), "INBOX")).resolves.toMatchObject({
      messages: 1,
    });
  });

  it("drops the gate entry once an account goes idle", async () => {
    const fake = makeTrackingFactory();
    const protocol = createMailProtocol(config, fake);

    await protocol.getFolderStatus(credential("cleanup@qq.com"), "INBOX");

    expect(imapAccountGateStateForTest("cleanup@qq.com")).toBeUndefined();
  });
});
