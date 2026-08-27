import { describe, expect, it } from "bun:test";
import { createMailProtocol, type MailCredential } from "./protocol";

/**
 * 回归钉死:imapflow 的 store/expunge/move 收到服务器 OK 即返回 true,而 UID 命令
 * 对不存在的 UID 静默成功——变更动作必须先探测存在性,否则过期 UID 虚报成功。
 * fake client 刻意模拟真实库语义(对不存在 UID 照样返回 true)。
 */
function makeFakeClient(
  messageExists: boolean,
  options?: {
    folders?: Array<Record<string, unknown>>;
    uidValidity?: bigint;
    /** mailboxOpen 注入 imapflow 形态的错误(NO/BAD 细节在 serverResponseCode/response)。 */
    openError?: unknown;
  },
) {
  let fetchCalls = 0;
  let currentUidValidity = options?.uidValidity;
  const moveTargets: string[] = [];
  const errorListeners: Array<[string, (error: Error) => void]> = [];
  const client = {
    connect: async () => {},
    logout: async () => {},
    close: () => {},
    list: async () =>
      options?.folders ?? [{ path: "Trash", name: "Trash", delimiter: "/", flags: [], specialUse: "\\Trash" }],
    mailboxOpen: async () => {
      if (options?.openError !== undefined) throw options.openError;
      return { ...(currentUidValidity !== undefined ? { uidValidity: currentUidValidity } : {}) };
    },
    search: async () => [1],
    fetchAll: async () => [],
    fetchOne: async () => {
      fetchCalls += 1;
      return messageExists ? { uid: 1, envelope: {} } : false;
    },
    messageFlagsAdd: async () => true,
    messageFlagsRemove: async () => true,
    messageMove: async (_range: number[], targetFolder: string) => {
      moveTargets.push(targetFolder);
      return { path: targetFolder };
    },
    messageDelete: async () => true,
    status: async () => ({}),
    /** 模拟邮箱删除重建:UIDVALIDITY 计数器重置。 */
    resetUidValidity(next: bigint) {
      currentUidValidity = next;
    },
    on(event: string, listener: (error: Error) => void) {
      errorListeners.push([event, listener]);
      return client;
    },
  };
  return { client, errorListeners, moveTargets, get fetchCount() { return fetchCalls; } };
}

/** imapflow 对命令 NO/BAD 的真实错误形态:message 恒为 "Command failed",细节在另两个字段。 */
const IMAPFLOW_FOLDER_MISSING_ERROR = Object.assign(new Error("Command failed"), {
  serverResponseCode: "NONEXISTENT",
  response: "* NO [NONEXISTENT] Mailbox doesn't exist: Missing (0.001 + 0.1 ns)",
});

let uidGuardSeq = 0;
// 池按账号键控且连接跨动作复用:每个用例独立邮箱,避免吃到上一用例留池的 fake 连接
const credential = (): MailCredential => ({
  email: `uid-guard-${++uidGuardSeq}@qq.com`,
  authorizationCode: "abcd1234efgh5678",
  imapHost: "imap.qq.com",
  smtpHost: "smtp.qq.com",
});

// 纯 UID 语义测试与连接期 host-pinning 无关:显式豁免避免默认 pinning 触发真实 DNS
const config = { displayName: "QQ 邮箱", attachmentFallbackPrefix: "attachment", enforceHostNetworkPolicy: false };

describe("mail mutation actions probe uid existence first", () => {
  it("rejects delete on a missing uid even though the library reports success", async () => {
    const fake = makeFakeClient(false);
    const protocol = createMailProtocol(config, { createImapClient: () => fake.client });

    await expect(protocol.deleteMessage(credential(), "INBOX", 999)).rejects.toMatchObject({
      kind: "uid_not_found",
    });
    // 探测先于变更:fetchOne 至少被调用一次(注意不可解构 getter——会立即求值成快照)
    expect(fake.fetchCount).toBeGreaterThan(0);
  });

  it("rejects flag changes on missing uids the same way", async () => {
    const { client } = makeFakeClient(false);
    const protocol = createMailProtocol(config, { createImapClient: () => client });

    await expect(protocol.markSeen(credential(), "INBOX", 999)).rejects.toMatchObject({ kind: "uid_not_found" });
    await expect(protocol.markUnseen(credential(), "INBOX", 999)).rejects.toMatchObject({ kind: "uid_not_found" });
    await expect(protocol.moveMessage(credential(), "INBOX", 999, "Trash")).rejects.toMatchObject({
      kind: "uid_not_found",
    });
  });

  it("still succeeds on an existing uid", async () => {
    const { client } = makeFakeClient(true);
    const protocol = createMailProtocol(config, { createImapClient: () => client });

    await expect(protocol.deleteMessage(credential(), "INBOX", 1)).resolves.toBe("Trash");
    await expect(protocol.markSeen(credential(), "INBOX", 1)).resolves.toBeUndefined();
  });
});

describe("delete_email moves into Trash instead of hard expunging (#691)", () => {
  it("moves the message to the server's \\Trash folder and reports the path", async () => {
    const fake = makeFakeClient(true);
    const protocol = createMailProtocol(config, { createImapClient: () => fake.client });

    await expect(protocol.deleteMessage(credential(), "INBOX", 1)).resolves.toBe("Trash");
    expect(fake.moveTargets).toEqual(["Trash"]);
  });

  it("refuses when the server has no \\Trash instead of falling back to a permanent delete", async () => {
    const fake = makeFakeClient(true, { folders: [] });
    const protocol = createMailProtocol(config, { createImapClient: () => fake.client });

    await expect(protocol.deleteMessage(credential(), "INBOX", 1)).rejects.toMatchObject({
      kind: "trash_missing",
    });
    // 拒绝路径不得触碰消息本身
    expect(fake.moveTargets).toEqual([]);
  });
});

describe("mutation actions verify UIDVALIDITY before writing (#690)", () => {
  it("rejects a write with no observed baseline (fail-closed after process restart)", async () => {
    const fake = makeFakeClient(true, { uidValidity: 100n });
    const protocol = createMailProtocol(config, { createImapClient: () => fake.client });

    await expect(protocol.markSeen(credential(), "INBOX", 1)).rejects.toMatchObject({
      kind: "uid_validity_changed",
    });
  });

  it("allows a write after a read established the baseline, and rejects after a reset", async () => {
    const fake = makeFakeClient(true, { uidValidity: 100n });
    const protocol = createMailProtocol(config, { createImapClient: () => fake.client });
    const account = credential();

    // 读动作建立基准
    await protocol.searchSummaries(account, "INBOX", {}, { limit: 5, peek: true });
    await expect(protocol.markSeen(account, "INBOX", 1)).resolves.toBeUndefined();

    // 文件夹删除重建:计数器重置后旧 UID 全部作废
    fake.client.resetUidValidity(200n);
    await expect(protocol.deleteMessage(account, "INBOX", 1)).rejects.toMatchObject({
      kind: "uid_validity_changed",
    });

    // 重新 search 后拿到新鲜基准,写恢复放行
    await protocol.searchSummaries(account, "INBOX", {}, { limit: 5, peek: true });
    await expect(protocol.deleteMessage(account, "INBOX", 1)).resolves.toBe("Trash");
  });

  it("shares the uid-validity ledger across letter-case variants of one address", async () => {
    const fake = makeFakeClient(true, { uidValidity: 100n });
    const protocol = createMailProtocol(config, { createImapClient: () => fake.client });
    const account = credential();

    // 大小写变体建立基准后,另一变体的写动作不得因「无基准」被误拒(#735 审查)
    await protocol.searchSummaries({ ...account, email: account.email.toUpperCase() }, "INBOX", {}, { limit: 5, peek: true });
    await expect(protocol.markSeen(account, "INBOX", 1)).resolves.toBeUndefined();
  });
});

describe("imapflow error shape handling", () => {
  it("classifies folder-missing from serverResponseCode/response, not from message", async () => {
    // 回归钉死:imapflow 的 NO/BAD 错误 message 恒为 "Command failed",
    // 响应码在 serverResponseCode、原文在 response——读 .code/.message 永远不命中
    const { client } = makeFakeClient(true, { openError: IMAPFLOW_FOLDER_MISSING_ERROR });
    const protocol = createMailProtocol(config, { createImapClient: () => client });

    await expect(protocol.deleteMessage(credential(), "Missing", 1)).rejects.toMatchObject({
      kind: "folder_not_found",
    });
  });

  it("attaches a transport error listener so async socket failures stay contained", async () => {
    const fake = makeFakeClient(true);
    const protocol = createMailProtocol(config, { createImapClient: () => fake.client });
    await protocol.deleteMessage(credential(), "INBOX", 1);

    const registered = fake.errorListeners.filter(([event]) => event === "error");
    expect(registered.length).toBeGreaterThan(0);
    const [firstEvent, firstListener] = registered[0] ?? [];
    expect(firstEvent).toBe("error");
    expect(typeof firstListener).toBe("function");
  });
});
