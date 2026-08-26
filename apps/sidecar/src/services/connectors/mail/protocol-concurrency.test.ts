import { describe, expect, it } from "bun:test";
import {
  createMailProtocol,
  imapAccountGateStateForTest,
  imapIdleReuseTtlMs,
  maxImapConnectionsPerAccount,
  maxImapWaitersPerAccount,
  type MailCredential,
} from "./protocol";

/**
 * 回归钉死 #698 及其连接复用后续:按账号连接池(容量 ≤2)必须把同账号
 * 在途连接压到上限之下,不同账号互不牵连、错误路径照常归还名额;
 * 成功连接入池复用(一动作一连接成为历史),过期/host 更换/出错即销毁。
 */
interface TrackingFactoryOptions {
  /** 让 connect() 失败指定次数后恢复,覆盖「建连失败走 close 兜底」的名额归还分支。 */
  failConnectTimes?: number;
  /** status() 挂起到该 promise 决算,用于手动控制名额持有窗口。 */
  holdStatus?: Promise<void>;
  /** 让 logout() 必败,覆盖「graceful 回收失败退 close」分支。 */
  failLogout?: boolean;
  /** 让 close() 自身抛错,覆盖「清理兜底吞错不顶替业务结果」分支。 */
  throwOnClose?: boolean;
}

function makeTrackingFactory(options: TrackingFactoryOptions = {}) {
  let live = 0;
  let peak = 0;
  let created = 0;
  let clock = 0;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
  return {
    get peak() {
      return peak;
    },
    get created() {
      return created;
    },
    get live() {
      return live;
    },
    /** 推进注入时钟,驱动池化连接的空闲 TTL 判定。 */
    advanceClock(ms: number) {
      clock += ms;
    },
    deps: {
      now: () => clock,
      createImapClient: () => {
        created += 1;
        live += 1;
        peak = Math.max(peak, live);
        // 与终结出口对齐:logout(graceful 回收)与 close(立即销毁/兜底)
        // 都代表连接终结,幂等归还计数;idle 归还不终结、不计入
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
            if (options.failConnectTimes !== undefined && options.failConnectTimes > 0) {
              options.failConnectTimes -= 1;
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
    },
  };
}

let emailSeq = 0;
/** 每次返回全新邮箱:池按账号键控,独立邮箱才能保证用例互不吃池。 */
function credential(email?: string): MailCredential {
  return {
    email: email ?? `pool-case-${++emailSeq}@qq.com`,
    authorizationCode: "abcd1234efgh5678",
    imapHost: "imap.qq.com",
    smtpHost: "smtp.qq.com",
  };
}

// 并发闸门测试与连接期 host-pinning 无关:显式豁免避免默认 pinning 触发真实 DNS
const config = { displayName: "QQ 邮箱", attachmentFallbackPrefix: "attachment", enforceHostNetworkPolicy: false };

describe("per-account IMAP connection pool (#698)", () => {
  it("caps concurrent connections for one account while keeping all calls successful", async () => {
    const fake = makeTrackingFactory();
    const protocol = createMailProtocol(config, fake.deps);
    const account = credential();

    const results = await Promise.all(
      Array.from({ length: 6 }, () => protocol.getFolderStatus(account, "INBOX")),
    );

    expect(results).toHaveLength(6);
    // 结果完整穿过池与闸门返回,而非仅 promise settle
    expect(results.every((result) => result.messages === 1)).toBe(true);
    expect(fake.peak).toBe(maxImapConnectionsPerAccount);
  });

  it("tracks accounts independently so one busy mailbox never blocks another", async () => {
    const fake = makeTrackingFactory();
    const protocol = createMailProtocol(config, fake.deps);
    const [accountA, accountB] = [credential(), credential()];

    await Promise.all([
      ...Array.from({ length: 3 }, () => protocol.getFolderStatus(accountA, "INBOX")),
      ...Array.from({ length: 3 }, () => protocol.getFolderStatus(accountB, "INBOX")),
    ]);

    expect(fake.peak).toBe(maxImapConnectionsPerAccount * 2);
  });

  it("merges letter-case variants of one address into the same pool", async () => {
    const fake = makeTrackingFactory();
    const protocol = createMailProtocol(config, fake.deps);

    await Promise.all([
      protocol.getFolderStatus({ ...credential(), email: "User@QQ.com" }, "INBOX"),
      protocol.getFolderStatus({ ...credential(), email: "user@qq.com" }, "INBOX"),
      protocol.getFolderStatus({ ...credential(), email: "USER@QQ.COM" }, "INBOX"),
    ].map((p, i) => p.then(() => i)));

    // 若大小写变体各开一池,三路直入会把峰值推到 3
    expect(fake.peak).toBe(maxImapConnectionsPerAccount);
  });

  it("reuses one pooled connection across sequential actions instead of reconnecting", async () => {
    const fake = makeTrackingFactory();
    const protocol = createMailProtocol(config, fake.deps);
    const account = credential();

    await protocol.getFolderStatus(account, "INBOX");
    await protocol.getFolderStatus(account, "INBOX");
    await protocol.searchSummaries(account, "INBOX", {}, { limit: 5, peek: true });

    // 池化的存在证明:三个动作只建了一条连接
    expect(fake.created).toBe(1);
    // 连接留在池中等待后续复用
    expect(imapAccountGateStateForTest(account.email)).toMatchObject({
      active: 0,
      waiting: 0,
      idle: 1,
    });
  });

  it("destroys and rebuilds a pooled connection once its idle TTL expires", async () => {
    const fake = makeTrackingFactory();
    const protocol = createMailProtocol(config, fake.deps);
    const account = credential();

    await protocol.getFolderStatus(account, "INBOX");
    expect(fake.created).toBe(1);

    fake.advanceClock(imapIdleReuseTtlMs + 1);
    await protocol.getFolderStatus(account, "INBOX");

    // 过期连接被 graceful 回收(logout 终结计数),动作用新建连接完成
    expect(fake.created).toBe(2);
    expect(fake.live).toBe(1);
  });

  it("does not hand a pooled connection to a credential pointing at another host", async () => {
    const fake = makeTrackingFactory();
    const protocol = createMailProtocol(config, fake.deps);
    const account = credential();

    await protocol.getFolderStatus(account, "INBOX");
    expect(fake.created).toBe(1);

    // 用户更改 IMAP host 设置:同邮箱、不同 host,旧连接不得跨 host 复用
    await protocol.getFolderStatus({ ...account, imapHost: "imap.new-provider.com" }, "INBOX");

    expect(fake.created).toBe(2);
    expect(fake.live).toBe(1);
  });

  it("releases slots when connect fails so the account does not dead-lock", async () => {
    const fake = makeTrackingFactory({ failConnectTimes: 6 });
    const protocol = createMailProtocol(config, fake.deps);
    const account = credential();

    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, () => protocol.getFolderStatus(account, "INBOX")),
    );

    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    // 名额未被失败吞掉:后续调用仍能拿到连接并成功返回
    await expect(protocol.getFolderStatus(account, "INBOX")).resolves.toMatchObject({
      messages: 1,
    });
    expect(fake.peak).toBe(maxImapConnectionsPerAccount);
  });

  it("keeps the gate healthy when actions reject mid-flight", async () => {
    const fake = makeTrackingFactory();
    const protocol = createMailProtocol(config, fake.deps);
    const account = credential();

    const outcomes = await Promise.allSettled([
      ...Array.from({ length: 2 }, () => protocol.deleteMessage(account, "INBOX", 999)),
      ...Array.from({ length: 4 }, () => protocol.getFolderStatus(account, "INBOX")),
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
    // 出错连接已销毁、名额照常归还:账号照常可用
    await expect(protocol.getFolderStatus(account, "INBOX")).resolves.toMatchObject({
      messages: 1,
    });
  });

  it("aborts a queued waiter and returns its reserved slot without waking successors", async () => {
    let releaseHolders!: () => void;
    const hold = new Promise<void>((resolve) => (releaseHolders = resolve));
    const fake = makeTrackingFactory({ holdStatus: hold });
    const protocol = createMailProtocol(config, fake.deps);
    const account = credential();

    const holders = [
      protocol.getFolderStatus(account, "INBOX"),
      protocol.getFolderStatus(account, "INBOX"),
    ];
    const abort = new AbortController();
    const queued = protocol.validateImapCredential(account, abort.signal);
    // 后继排在被中止者身后:P1 回归位——若取消路径转交「虚」预占,
    // 后继会立即建连使真实连接数突破上限
    const successor = protocol.getFolderStatus(account, "INBOX");
    await new Promise((resolve) => setTimeout(resolve, 1));
    // 排队即预占:active = 两名额持有者 + X + Y 的预占
    expect(imapAccountGateStateForTest(account.email)).toMatchObject({
      active: maxImapConnectionsPerAccount + 2,
      waiting: 2,
    });

    abort.abort(new Error("budget gone"));
    await expect(queued).rejects.toThrow("budget gone");
    // 中止者退队归还预占;后继必须仍在排队(未被提前放行),真实连接仍为 2
    expect(imapAccountGateStateForTest(account.email)).toMatchObject({
      active: maxImapConnectionsPerAccount + 1,
      waiting: 1,
    });
    expect(fake.peak).toBe(maxImapConnectionsPerAccount);

    releaseHolders();
    await Promise.all([...holders, successor]);
    // 成功连接入池待复用:活跃清零但条目随池留存
    expect(imapAccountGateStateForTest(account.email)).toMatchObject({
      active: 0,
      waiting: 0,
    });
    // 名额记账完好:账号照常可用
    await expect(protocol.getFolderStatus(account, "INBOX")).resolves.toMatchObject({ messages: 1 });
  });

  it("leaves the ledger untouched when called with an already-aborted signal", async () => {
    let releaseHolders!: () => void;
    const hold = new Promise<void>((resolve) => (releaseHolders = resolve));
    const fake = makeTrackingFactory({ holdStatus: hold });
    const protocol = createMailProtocol(config, fake.deps);
    const account = credential();

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
    expect(imapAccountGateStateForTest(account.email)).toMatchObject({
      active: maxImapConnectionsPerAccount + 1,
      waiting: 1,
    });

    releaseHolders();
    await Promise.all(holders);
    await queued;
    expect(imapAccountGateStateForTest(account.email)).toMatchObject({ active: 0, waiting: 0 });
  });

  it("fast-fails beyond the queue depth cap without breaking the slot ledger", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const fake = makeTrackingFactory({ holdStatus: hold });
    const protocol = createMailProtocol(config, fake.deps);
    const account = credential();

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
  });

  it("falls back to close when a graceful TTL recycle fails to log out", async () => {
    const fake = makeTrackingFactory({ failLogout: true });
    const protocol = createMailProtocol(config, fake.deps);
    const account = credential();

    await protocol.getFolderStatus(account, "INBOX");
    expect(fake.created).toBe(1);

    // TTL 过期触发 graceful 回收,logout 必败须退 close 兜底,业务不受影响
    fake.advanceClock(imapIdleReuseTtlMs + 1);
    await expect(protocol.getFolderStatus(account, "INBOX")).resolves.toMatchObject({ messages: 1 });
    expect(fake.created).toBe(2);
  });

  it("keeps the business error intact when the fallback close itself throws", async () => {
    const fake = makeTrackingFactory({ failConnectTimes: 1, throwOnClose: true });
    const protocol = createMailProtocol(config, fake.deps);
    const account = credential();

    // connect 失败的业务错误(auth)不被 close 的爆炸顶替
    await expect(protocol.getFolderStatus(account, "INBOX")).rejects.toMatchObject({ kind: "auth" });
    // 名额未被清理爆炸吞掉:账号照常可用;成功连接照常入池
    await expect(protocol.getFolderStatus(account, "INBOX")).resolves.toMatchObject({ messages: 1 });
    expect(imapAccountGateStateForTest(account.email)).toMatchObject({ active: 0, waiting: 0, idle: 1 });
  });

  it("ignores an abort that arrives after the slot was granted", async () => {
    const fake = makeTrackingFactory();
    const protocol = createMailProtocol(config, fake.deps);
    const account = credential();
    const abort = new AbortController();

    const queued = protocol.validateImapCredential(account, abort.signal);
    await queued;
    abort.abort(new Error("too late"));
    // 契约钉死:名额已兑现后 signal 中止不再有任何记账效应
    expect(imapAccountGateStateForTest(account.email)).toMatchObject({ active: 0, waiting: 0 });
  });
});
