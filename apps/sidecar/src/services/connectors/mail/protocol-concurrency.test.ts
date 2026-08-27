import { describe, expect, it } from "bun:test";
import {
  createMailProtocol,
  imapAccountGateStateForTest,
  imapIdleReuseTtlMs,
  imapPoolMetricsSnapshot,
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
  /** status() 挂起到该 promise 决算,用于手动控制名额持有窗口;数组形态按
   * client 创建序逐一绑定,用于精确控制并发两条连接的完成顺序。 */
  holdStatus?: Promise<void> | Array<Promise<void>>;
  /** fetchOne(uid=1) 挂起到该 promise 决算:控制 withMailbox 类动作(markSeen)
   * 的完成时刻,从而固定「非选中在前、SELECTED 在后」的池内候选序。 */
  holdFetchOne?: Promise<void>;
  /** 让 close() 自身抛错,覆盖「清理兜底吞错不顶替业务结果」分支。 */
  throwOnClose?: boolean;
  /** 让 messageFlagsAdd 抛网络错(ECONNRESET),覆盖传输层错误销毁连接的分支。 */
  failFlagsNetwork?: boolean;
}

function makeTrackingFactory(options: TrackingFactoryOptions = {}) {
  let live = 0;
  let peak = 0;
  let created = 0;
  // 以真实时间为基:未注入时钟的测试文件(裸 Date.now)落池的连接,idledAt
  // 与本工厂时钟同刻度,模块级清扫(#784① 测试的冲刷步骤)才能正确判其过期
  let clock = Date.now();
  let logoutCalls = 0;
  let closeCalls = 0;
  const clients: Array<{ __emitError: () => void }> = [];
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
    get logoutCalls() {
      return logoutCalls;
    },
    get closeCalls() {
      return closeCalls;
    },
    get clients() {
      return clients;
    },
    /** 推进注入时钟,驱动池化连接的空闲 TTL 判定。 */
    advanceClock(ms: number) {
      clock += ms;
    },
    deps: {
      now: () => clock,
      createImapClient: (configArg: Record<string, unknown>) => {
        created += 1;
        live += 1;
        peak = Math.max(peak, live);
        let released = false;
        const release = () => {
          if (!released) {
            released = true;
            live -= 1;
          }
        };
        // 模拟 imapflow 的 EventEmitter 面:error 监听置 dead 标记是
        // 借出淘汰的依据,mailboxOpen 置选中态是 requireUnselected 的依据
        let mailbox: object | undefined;
        const errorListeners: Array<(error: Error) => void> = [];
        const client = {
          get mailbox() {
            return mailbox;
          },
          on(event: string, listener: (error: Error) => void) {
            if (event === "error") {
              errorListeners.push(listener);
            }
          },
          connect: async () => {
            await tick();
            const auth = (configArg as { auth?: { pass?: string } }).auth;
            if (auth?.pass && auth.pass !== "abcd1234efgh5678") {
              throw new Error("LOGIN failed (AUTHENTICATIONFAILED)");
            }
            if (options.failConnectTimes !== undefined && options.failConnectTimes > 0) {
              options.failConnectTimes -= 1;
              throw new Error("LOGIN failed (AUTHENTICATIONFAILED)");
            }
          },
          logout: async () => {
            logoutCalls += 1;
            release();
          },
          close: () => {
            closeCalls += 1;
            release();
            if (options.throwOnClose) {
              throw new Error("close exploded");
            }
          },
          list: async () => [],
          mailboxOpen: async () => {
            mailbox = { path: "INBOX" };
            return {};
          },
          search: async () => [1],
          fetchAll: async () => [],
          // 仅 uid=1 存在:uid=999 走 uid_not_found 业务错,uid=1 可进到动作阶段
          fetchOne: async (targetUid: number) => {
            if (options.holdFetchOne && targetUid === 1) {
              await options.holdFetchOne;
            }
            return targetUid === 1;
          },
          messageFlagsRemove: async () => true,
          messageFlagsAdd: async () => {
            if (options.failFlagsNetwork) {
              throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
            }
            return true;
          },
          messageMove: async () => ({ path: "target" }),
          messageDelete: async () => true,
          status: async () => {
            const hold = Array.isArray(options.holdStatus) ? options.holdStatus.shift() : options.holdStatus;
            if (hold) {
              await hold;
            }
            return { messages: 1 };
          },
          download: async () => ({ meta: {}, content: [] }),
        };
        const withTrigger = Object.assign(client, {
          __emitError: () => {
            for (const listener of errorListeners) {
              listener(new Error("simulated transport failure"));
            }
          },
        });
        clients.push(withTrigger);
        return client;
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

    // 过期连接被同步 close 销毁(close 终结计数),动作用新建连接完成
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

  it("destroys expired pooled connections synchronously without a fire-and-forget LOGOUT", async () => {
    // P1 回归位:fire-and-forget LOGOUT 的 RTT 窗口会与紧随的新 LOGIN 在
    // 服务端叠加成 cap+1 会话(#698 超限误判模式回归),驱逐必须同步 close
    const fake = makeTrackingFactory();
    const protocol = createMailProtocol(config, fake.deps);
    const account = credential();

    await protocol.getFolderStatus(account, "INBOX");
    expect(fake.created).toBe(1);

    fake.advanceClock(imapIdleReuseTtlMs + 1);
    await expect(protocol.getFolderStatus(account, "INBOX")).resolves.toMatchObject({ messages: 1 });

    expect(fake.created).toBe(2);
    expect(fake.closeCalls).toBeGreaterThanOrEqual(1);
    expect(fake.logoutCalls).toBe(0);
  });

  it("never returns an erroring connection to the pool", async () => {
    const fake = makeTrackingFactory();
    const protocol = createMailProtocol(config, fake.deps);
    const account = credential();

    const outcomes = await Promise.allSettled([
      ...Array.from({ length: 2 }, () => protocol.deleteMessage(account, "INBOX", 999)),
      ...Array.from({ length: 4 }, () => protocol.getFolderStatus(account, "INBOX")),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(2);

    // 「错误即销毁」承重不变式:存活连接数恰等于池中 idle 数——
    // 出错连接已销毁,没有任何死连接滞留池外或池内
    const gateState = imapAccountGateStateForTest(account.email);
    expect(gateState?.idle).toBeGreaterThan(0);
    expect(fake.live).toBe(gateState!.idle);
  });

  it("does not let a rotated authorization code ride on a pooled session", async () => {
    const fake = makeTrackingFactory();
    const protocol = createMailProtocol(config, fake.deps);
    const account = credential();
    const rotated = { ...account, authorizationCode: "wrong-code-9999" };
    const before = imapPoolMetricsSnapshot();

    await protocol.validateImapCredential(account);
    expect(fake.created).toBe(1);

    // fail-open 回归位(#768 审查):换错误授权码重新验证必须真实重连被拒,
    // 而不是复用旧凭证会话假通过
    await expect(protocol.validateImapCredential(rotated)).rejects.toMatchObject({ kind: "auth" });
    expect(fake.created).toBe(2);
    // 授权码失配的池内候选被 miss_auth 淘汰(ternary 链唯一无断言分支,钉死)
    expect(imapPoolMetricsSnapshot().miss_auth - before.miss_auth).toBe(1);
  });

  it("replaces a pooled connection that the server or watchdog has killed", async () => {
    const fake = makeTrackingFactory();
    const protocol = createMailProtocol(config, fake.deps);
    const account = credential();

    await protocol.getFolderStatus(account, "INBOX");
    expect(fake.created).toBe(1);

    // 模拟 imapflow 空闲看门狗/socket 故障 emit("error"):连接置 dead。
    // P0 回归位:无此监听时该 emit 是无监听 error → uncaughtException;
    // 有监听后置 dead,借出前淘汰换新,而不是把死连接交给 callback
    fake.clients[0]!.__emitError();
    await expect(protocol.getFolderStatus(account, "INBOX")).resolves.toMatchObject({ messages: 1 });
    expect(fake.created).toBe(2);
    expect(imapAccountGateStateForTest(account.email)).toMatchObject({ active: 0, waiting: 0, idle: 1 });
  });

  it("requires a non-selected connection for STATUS even when the pool has one", async () => {
    const fake = makeTrackingFactory();
    const protocol = createMailProtocol(config, fake.deps);
    const account = credential();

    // searchSummaries 经 withMailbox(EXAMINE)把连接置 selected 态后归还
    await protocol.searchSummaries(account, "INBOX", {}, { limit: 5, peek: true });
    expect(imapAccountGateStateForTest(account.email)).toMatchObject({ idle: 1 });

    // RFC 3501 §6.3.10(SHOULD NOT):STATUS 不发往当前选中的邮箱——驱逐重建
    await expect(protocol.getFolderStatus(account, "INBOX")).resolves.toMatchObject({ messages: 1 });
    expect(fake.created).toBe(2);
  });

  it("keeps pool idle untouched when a queued waiter aborts behind it", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const fake = makeTrackingFactory({ holdStatus: hold });
    const protocol = createMailProtocol(config, fake.deps);
    const account = credential();

    // 留一条 authenticated 态 idle(list 族动作;getFolderStatus 会因
    // requireUnselected 驱逐 selected 连接,不适合做这里的池种子)
    await protocol.listFolders(account);
    expect(imapAccountGateStateForTest(account.email)).toMatchObject({ idle: 1 });

    // 两个名额被挂住的 STATUS 占满,W1 排队后中止
    const holders = [
      protocol.getFolderStatus(account, "INBOX"),
      protocol.getFolderStatus(account, "INBOX"),
    ];
    const abort = new AbortController();
    const queued = protocol.validateImapCredential(account, abort.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    // 钉死 W1 真的排过队:排队记账被删时此断言先红,而非整文件挂死
    expect(imapAccountGateStateForTest(account.email)).toMatchObject({ waiting: 1 });
    abort.abort(new Error("budget gone"));
    await expect(queued).rejects.toThrow("budget gone");

    release();
    await Promise.all(holders);
    // 中止者从未借出连接:池内连接照常流转,后续动作复用不再新建
    const createdAfterHolders = fake.created;
    await expect(protocol.getFolderStatus(account, "INBOX")).resolves.toMatchObject({ messages: 1 });
    expect(fake.created).toBe(createdAfterHolders);
  });

  it("drops the whole gate entry once every connection is destroyed", async () => {
    const fake = makeTrackingFactory({ failFlagsNetwork: true });
    const protocol = createMailProtocol(config, fake.deps);
    const account = credential();

    // 成功动作留一条 idle
    await protocol.getFolderStatus(account, "INBOX");
    expect(imapAccountGateStateForTest(account.email)).toMatchObject({ idle: 1 });

    // 下一个动作借走该 idle 并因传输层错误销毁:(active, waiting, idle) 全零 → 条目删除
    // (业务错如 uid_not_found 已改为健康回流,#784① P1;传输层错误才是销毁路径)
    await expect(protocol.markSeen(account, "INBOX", 1)).rejects.toMatchObject({
      kind: "network",
    });
    expect(imapAccountGateStateForTest(account.email)).toBeUndefined();
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

  it("classifies pool lifecycle events into metrics counters (#784①)", async () => {
    const fake = makeTrackingFactory();
    const protocol = createMailProtocol(config, fake.deps);
    const account = credential();

    // 计数器是模块级单例:先把时钟推过 TTL 触发一次全局清扫,冲掉此前用例
    // 遗留在池中的条目,再取基线,避免他例连接被我方推进的时钟误扫成 miss
    fake.advanceClock(imapIdleReuseTtlMs * 10);
    await protocol.listFolders(account);
    const before = imapPoolMetricsSnapshot();

    // 复用 → pool_hit
    await protocol.getFolderStatus(account, "INBOX");

    // TTL 过期由入口搭车清扫先行消化(非借出路径),随后借出只能新建
    fake.advanceClock(imapIdleReuseTtlMs + 1);
    await protocol.getFolderStatus(account, "INBOX");

    // EXAMINE 置选中态后,getFolderStatus 的 requireUnselected 借出淘汰候选并新建
    await protocol.searchSummaries(account, "INBOX", { unseen: true }, { limit: 5, peek: true });
    await protocol.getFolderStatus(account, "INBOX");

    // 池内空闲连接被看门狗 emit error 杀死:error_destroy 记在监听侧;
    // 死条目滞留池中直到下次借出才被 miss_dead 淘汰
    fake.clients.at(-1)!.__emitError();
    await protocol.getFolderStatus(account, "INBOX");

    // 动作失败(uid_not_found)→ 业务语义错不杀健康连接(#784① P1):借出计 hit,
    // 连接健康回流池中,后续同账号借出继续命中(无新建、无 error_destroy)
    await expect(protocol.markSeen(account, "INBOX", 999)).rejects.toMatchObject({ kind: "uid_not_found" });

    // 同账号下一次借出直接命中回流连接(markSeen 的选中态不碍非 requireUnselected 借出)
    await protocol.listFolders(account);

    // 换 host 借出:旧连接不复用 → miss_host + 新建
    await protocol.getFolderStatus({ ...account, imapHost: "imap.example.com" }, "INBOX");

    const after = imapPoolMetricsSnapshot();
    // 新建点:TTL 过期 / requireUnselected / miss_dead / host 变更
    expect(after.created - before.created).toBe(4);
    // 复用点:前段 getFolderStatus/searchSummaries ×2 + markSeen + 回流后 listFolders
    expect(after.pool_hit - before.pool_hit).toBe(4);
    expect(after.miss_ttl - before.miss_ttl).toBe(1);
    expect(after.miss_dead - before.miss_dead).toBe(1);
    expect(after.miss_unselected - before.miss_unselected).toBe(1);
    expect(after.miss_host - before.miss_host).toBe(1);
    expect(after.error_destroy - before.error_destroy).toBe(1);
    // host 变更新建照常入池
    expect(after.idle_connections).toBe(1);
  });

  it("entry sweep evicts stale idle connections of silent accounts (#784① P1)", async () => {
    const fake = makeTrackingFactory();
    const protocol = createMailProtocol(config, fake.deps);
    const dormant = credential();
    const active = credential();

    // 沉寂账号落一条 idle;此后它自己不再有任何借出可触达该条目
    await protocol.getFolderStatus(dormant, "INBOX");
    expect(imapAccountGateStateForTest(dormant.email)).toMatchObject({ idle: 1 });

    fake.advanceClock(imapIdleReuseTtlMs + 1);
    // 借出侧 TTL 判定够不着:无人进闸门时条目原样滞留(明文授权码进程级滞留)
    expect(imapAccountGateStateForTest(dormant.email)).toMatchObject({ idle: 1 });

    // 另一账号的一次动作触发入口全表搭车清扫
    const before = imapPoolMetricsSnapshot();
    await protocol.getFolderStatus(active, "INBOX");

    // 过期条目被清扫销毁、gate 条目随之删除;摘除 sweepStaleIdleConnections 调用时本用例红
    expect(imapAccountGateStateForTest(dormant.email)).toBeUndefined();
    const after = imapPoolMetricsSnapshot();
    expect(after.miss_ttl - before.miss_ttl).toBe(1);
  });

  it("lease scan keeps evicting candidates until the compatible one (#784① P1)", async () => {
    // 死连接作为压栈候选不可行:入口搭车清扫会在借出前先销毁 dead 条目,借出扫描
    // 只见单候选。两候选必须都被 sweep 视为健康(TTL 内、存活),不兼容性只能来自
    // getFolderStatus 的 requireUnselected 要求;用 status/fetchOne 双挂点固定
    // 完成序 ⇒ 入池序 [非选中在前, SELECTED 在后]。
    let releasePlain!: () => void;
    let releaseMarked!: () => void;
    const fake = makeTrackingFactory({
      holdStatus: [
        new Promise<void>((resolve) => {
          releasePlain = resolve;
        }),
      ],
      holdFetchOne: new Promise<void>((resolve) => {
        releaseMarked = resolve;
      }),
    });
    const protocol = createMailProtocol(config, fake.deps);
    const account = credential();

    // client1:getFolderStatus 挂在 status(全程非选中);client2:markSeen 挂在
    // fetchOne(SELECT 已生效,动作未完成不得入池)
    const plain = protocol.getFolderStatus(account, "INBOX");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const marked = protocol.markSeen(account, "INBOX", 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(imapAccountGateStateForTest(account.email)).toMatchObject({ active: 2 });

    releasePlain();
    await plain;
    expect(imapAccountGateStateForTest(account.email)).toMatchObject({ idle: 1, active: 1 });
    releaseMarked();
    await marked;

    // markSeen 已把第二条连接置为 SELECTED 且后入池(栈顶):
    // getFolderStatus(requireUnselected) 必须先淘汰它、再命中存活的非选中条目,
    // 而不是放弃扫描改走新建
    const before = imapPoolMetricsSnapshot();
    await protocol.getFolderStatus(account, "INBOX");

    expect(fake.created).toBe(2);
    const after = imapPoolMetricsSnapshot();
    expect(after.pool_hit - before.pool_hit).toBe(1);
    expect(after.miss_unselected - before.miss_unselected).toBe(1);
    // 单候选 pop 后放弃改走新建的变异 here 红(created 会变 3)
    expect(imapAccountGateStateForTest(account.email)).toMatchObject({ idle: 1 });
  });

  it("aggregates error_destroy kinds into the snapshot (#784②/#790)", async () => {
    const fake = makeTrackingFactory({ failFlagsNetwork: true });
    const protocol = createMailProtocol(config, fake.deps);
    const account = credential();

    // 模块级单例:先推时钟冲掉他例残留条目再取基线
    fake.advanceClock(imapIdleReuseTtlMs * 10);
    await protocol.listFolders(account);
    const before = imapPoolMetricsSnapshot();

    // 业务语义错健康回流(#806 口径):既不进 error_destroy 也不进 kind 细分表
    await expect(protocol.markSeen(account, "INBOX", 999)).rejects.toMatchObject({ kind: "uid_not_found" });

    // 看门狗 emit error 杀死空闲连接:kind=watchdog 记在监听侧
    fake.clients.at(-1)!.__emitError();
    await protocol.getFolderStatus(account, "INBOX");

    // 动作期传输层错误:kind=network,mapLibraryError 映射码进同一张细分表
    await expect(protocol.markSeen(account, "INBOX", 1)).rejects.toMatchObject({ kind: "network" });

    const after = imapPoolMetricsSnapshot();
    expect(after.error_destroy - before.error_destroy).toBe(2);
    const delta = (kind: string) =>
      (after.error_destroy_kinds[kind] ?? 0) - (before.error_destroy_kinds[kind] ?? 0);
    expect(delta("watchdog")).toBe(1);
    expect(delta("network")).toBe(1);
    expect(delta("provider")).toBe(0);
    expect(delta("auth")).toBe(0);
    // 守恒:error_destroy 每次都带 kind,总量增量恒等于细分增量之和
    const sumDelta = Object.keys(after.error_destroy_kinds).reduce(
      (sum, kind) => sum + ((after.error_destroy_kinds[kind] ?? 0) - (before.error_destroy_kinds[kind] ?? 0)),
      0,
    );
    expect(sumDelta).toBe(after.error_destroy - before.error_destroy);
  });

  it("matches pooled candidates case-insensitively on the imap host (#698 终审 P2)", async () => {
    const fake = makeTrackingFactory();
    const protocol = createMailProtocol(config, fake.deps);
    // 独立 email ⇒ 独立 gate,免模块级计数器冲刷
    const account = credential();

    await protocol.getFolderStatus({ ...account, imapHost: "IMAP.QQ.COM" }, "INBOX");
    const before = imapPoolMetricsSnapshot();
    // 仅字面量大小写差异不是换源:必须命中而非 miss_host 销毁重建
    await protocol.getFolderStatus({ ...account, imapHost: "imap.qq.com" }, "INBOX");

    const after = imapPoolMetricsSnapshot();
    expect(after.pool_hit - before.pool_hit).toBe(1);
    expect(after.created - before.created).toBe(0);
    expect(after.miss_host - before.miss_host).toBe(0);
  });
});
