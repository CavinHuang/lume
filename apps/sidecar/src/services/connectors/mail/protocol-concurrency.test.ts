import { describe, expect, it } from "bun:test";
import {
  createMailProtocol,
  imapAccountGateStateForTest,
  maxImapConnectionsPerAccount,
  maxImapWaitersPerAccount,
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
  /** status() 挂起到该 promise 决算,用于手动控制名额持有窗口。 */
  holdStatus?: Promise<void>;
  /** 让 logout() 必败,覆盖「logout 失败回退 close」的清理分支。 */
  failLogout?: boolean;
  /** 让 close() 自身抛错,覆盖「清理兜底吞错不顶替业务结果」分支。 */
  throwOnClose?: boolean;
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
          if (options.failLogout) {
            throw new Error("logout failed");
          }
        },
        close: () => {
          release();
          if (options.throwOnClose) {
            throw new Error("close exploded");
          }
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
        status: async () => {
          if (options.holdStatus) {
            await options.holdStatus;
          }
          return { messages: 1 };
        },
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

  it("aborts a queued waiter and returns its reserved slot without waking successors", async () => {
    let releaseHolders!: () => void;
    const hold = new Promise<void>((resolve) => (releaseHolders = resolve));
    const fake = makeTrackingFactory({ holdStatus: hold });
    const protocol = createMailProtocol(config, fake);
    const account = credential("abort@qq.com");

    const holders = [
      protocol.getFolderStatus(account, "INBOX"),
      protocol.getFolderStatus(account, "INBOX"),
    ];
    const abort = new AbortController();
    const queued = protocol.validateImapCredential(account, abort.signal);
    // 后继排在被中止者身后:P1 回归位——若取消路径 shift 转交「虚」预占,
    // 后继会立即建连使真实连接数突破上限
    const successor = protocol.getFolderStatus(account, "INBOX");
    await new Promise((resolve) => setTimeout(resolve, 1));
    // 排队即预占:active = 两名额持有者 + X + Y 的预占
    expect(imapAccountGateStateForTest("abort@qq.com")).toMatchObject({
      active: maxImapConnectionsPerAccount + 2,
      waiting: 2,
    });

    abort.abort(new Error("budget gone"));
    await expect(queued).rejects.toThrow("budget gone");
    // 中止者退队归还预占;后继必须仍在排队(未被提前放行),真实连接仍为 2
    expect(imapAccountGateStateForTest("abort@qq.com")).toMatchObject({
      active: maxImapConnectionsPerAccount + 1,
      waiting: 1,
    });
    expect(fake.peak).toBe(maxImapConnectionsPerAccount);

    releaseHolders();
    await Promise.all([...holders, successor]);
    expect(imapAccountGateStateForTest("abort@qq.com")).toBeUndefined();
    // 名额记账完好:账号照常可用
    await expect(protocol.getFolderStatus(account, "INBOX")).resolves.toMatchObject({ messages: 1 });
  });

  it("leaves the ledger untouched when called with an already-aborted signal", async () => {
    let releaseHolders!: () => void;
    const hold = new Promise<void>((resolve) => (releaseHolders = resolve));
    const fake = makeTrackingFactory({ holdStatus: hold });
    const protocol = createMailProtocol(config, fake);
    const account = credential("preabort@qq.com");

    const holders = [
      protocol.getFolderStatus(account, "INBOX"),
      protocol.getFolderStatus(account, "INBOX"),
    ];
    const queued = protocol.validateImapCredential(account, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 1));

    const aborted = new AbortController();
    aborted.abort(new Error("already gone"));
    await expect(protocol.validateImapCredential(account, aborted.signal)).rejects.toThrow("already gone");
    // 预检分支不动账:正常排队者 W1 的预占不被冒领
    expect(imapAccountGateStateForTest("preabort@qq.com")).toMatchObject({
      active: maxImapConnectionsPerAccount + 1,
      waiting: 1,
    });

    releaseHolders();
    await Promise.all(holders);
    await queued;
    expect(imapAccountGateStateForTest("preabort@qq.com")).toBeUndefined();
  });

  it("fast-fails beyond the queue depth cap without breaking the slot ledger", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const fake = makeTrackingFactory({ holdStatus: hold });
    const protocol = createMailProtocol(config, fake);
    const account = credential("cap@qq.com");

    const outcomes: Array<PromiseSettledResult<unknown>> = [];
    const calls = Array.from({ length: maxImapWaitersPerAccount + 3 }, () =>
      protocol.getFolderStatus(account, "INBOX").then(
        (value) => outcomes.push({ status: "fulfilled", value }),
        (reason) => outcomes.push({ status: "rejected", reason }),
      ),
    );
    // 同步发起即定局:2 直入 + maxImapWaitersPerAccount 排队,第 max+3 个超限快败
    await new Promise((resolve) => setTimeout(resolve, 5));
    const rejectedNow = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(rejectedNow).toHaveLength(1);
    expect((rejectedNow[0] as PromiseRejectedResult).reason).toMatchObject({ kind: "busy" });

    release();
    await Promise.all(calls);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(maxImapWaitersPerAccount + 2);
    expect(imapAccountGateStateForTest("cap@qq.com")).toBeUndefined();
  });

  it("falls back to close when logout fails, keeping the outcome and slot ledger intact", async () => {
    const fake = makeTrackingFactory({ failLogout: true });
    const protocol = createMailProtocol(config, fake);
    const account = credential("logout@qq.com");

    // 清理失败被静默兜底:业务结果不受影响(logout 在 finally 内吞错)
    await expect(protocol.getFolderStatus(account, "INBOX")).resolves.toMatchObject({ messages: 1 });
    // 名额照常归还:账号后续可用,gate 条目正常清理
    await expect(protocol.getFolderStatus(account, "INBOX")).resolves.toMatchObject({ messages: 1 });
    expect(imapAccountGateStateForTest("logout@qq.com")).toBeUndefined();
  });

  it("keeps the business error intact when the fallback close itself throws", async () => {
    const fake = makeTrackingFactory({ failConnectTimes: 1, throwOnClose: true });
    const protocol = createMailProtocol(config, fake);
    const account = credential("closethrow@qq.com");

    // connect 失败的业务错误(auth)不被 close 的爆炸顶替
    await expect(protocol.getFolderStatus(account, "INBOX")).rejects.toMatchObject({ kind: "auth" });
    // 名额未被清理爆炸吞掉:账号照常可用
    await expect(protocol.getFolderStatus(account, "INBOX")).resolves.toMatchObject({ messages: 1 });
    expect(imapAccountGateStateForTest("closethrow@qq.com")).toBeUndefined();
  });

  it("ignores an abort that arrives after the slot was granted", async () => {
    const fake = makeTrackingFactory();
    const protocol = createMailProtocol(config, fake);
    const account = credential("late-abort@qq.com");
    const abort = new AbortController();

    const queued = protocol.validateImapCredential(account, abort.signal);
    await queued;
    abort.abort(new Error("too late"));
    // 契约钉死:名额已兑现后 signal 中止不再有任何记账效应
    expect(imapAccountGateStateForTest("late-abort@qq.com")).toBeUndefined();
  });
});
