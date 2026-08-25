import { describe, expect, it } from "bun:test";
import { createMailProtocol, type MailCredential } from "./protocol";

/**
 * 回归钉死:imapflow 的 store/expunge/move 收到服务器 OK 即返回 true,而 UID 命令
 * 对不存在的 UID 静默成功——变更动作必须先探测存在性,否则过期 UID 虚报成功。
 * fake client 刻意模拟真实库语义(对不存在 UID 照样返回 true)。
 */
function makeFakeClient(messageExists: boolean, openError?: unknown) {
  let fetchCalls = 0;
  const errorListeners: Array<[string, (error: Error) => void]> = [];
  const client = {
    connect: async () => {},
    logout: async () => {},
    close: () => {},
    list: async () => [],
    mailboxOpen: async () => {
      if (openError !== undefined) throw openError;
      return {};
    },
    search: async () => [1],
    fetchAll: async () => [],
    fetchOne: async () => {
      fetchCalls += 1;
      return messageExists ? { uid: 1, envelope: {} } : false;
    },
    messageFlagsAdd: async () => true,
    messageFlagsRemove: async () => true,
    messageMove: async () => ({ path: "target" }),
    messageDelete: async () => true,
    status: async () => ({}),
    download: async () => ({ meta: {}, content: [] }),
    on(event: string, listener: (error: Error) => void) {
      errorListeners.push([event, listener]);
      return client;
    },
  };
  return { client, errorListeners, get fetchCount() { return fetchCalls; } };
}

/** imapflow 对命令 NO/BAD 的真实错误形态:message 恒为 "Command failed",细节在另两个字段。 */
const IMAPFLOW_FOLDER_MISSING_ERROR = Object.assign(new Error("Command failed"), {
  serverResponseCode: "NONEXISTENT",
  response: "* NO [NONEXISTENT] Mailbox doesn't exist: Missing (0.001 + 0.1 ns)",
});

const credential: MailCredential = {
  email: "user@qq.com",
  authorizationCode: "abcd1234efgh5678",
  imapHost: "imap.qq.com",
  smtpHost: "smtp.qq.com",
};

const config = { displayName: "QQ 邮箱", attachmentFallbackPrefix: "attachment" };

describe("mail mutation actions probe uid existence first", () => {
  it("rejects delete on a missing uid even though the library reports success", async () => {
    const fake = makeFakeClient(false);
    const protocol = createMailProtocol(config, { createImapClient: () => fake.client });

    await expect(protocol.deleteMessage(credential, "INBOX", 999)).rejects.toMatchObject({
      kind: "uid_not_found",
    });
    // 探测先于变更:fetchOne 至少被调用一次(注意不可解构 getter——会立即求值成快照)
    expect(fake.fetchCount).toBeGreaterThan(0);
  });

  it("rejects flag changes on missing uids the same way", async () => {
    const { client } = makeFakeClient(false);
    const protocol = createMailProtocol(config, { createImapClient: () => client });

    await expect(protocol.markSeen(credential, "INBOX", 999)).rejects.toMatchObject({ kind: "uid_not_found" });
    await expect(protocol.markUnseen(credential, "INBOX", 999)).rejects.toMatchObject({ kind: "uid_not_found" });
    await expect(protocol.moveMessage(credential, "INBOX", 999, "Trash")).rejects.toMatchObject({
      kind: "uid_not_found",
    });
  });

  it("still succeeds on an existing uid", async () => {
    const { client } = makeFakeClient(true);
    const protocol = createMailProtocol(config, { createImapClient: () => client });

    await expect(protocol.deleteMessage(credential, "INBOX", 1)).resolves.toBeUndefined();
    await expect(protocol.markSeen(credential, "INBOX", 1)).resolves.toBeUndefined();
  });
});

describe("imapflow error shape handling", () => {
  it("classifies folder-missing from serverResponseCode/response, not from message", async () => {
    // 回归钉死:imapflow 的 NO/BAD 错误 message 恒为 "Command failed",
    // 响应码在 serverResponseCode、原文在 response——读 .code/.message 永远不命中
    const { client } = makeFakeClient(true, IMAPFLOW_FOLDER_MISSING_ERROR);
    const protocol = createMailProtocol(config, { createImapClient: () => client });

    await expect(protocol.deleteMessage(credential, "Missing", 1)).rejects.toMatchObject({
      kind: "folder_not_found",
    });
  });

  it("attaches a transport error listener so async socket failures stay contained", async () => {
    const fake = makeFakeClient(true);
    const protocol = createMailProtocol(config, { createImapClient: () => fake.client });
    await protocol.deleteMessage(credential, "INBOX", 1);

    const registered = fake.errorListeners.filter(([event]) => event === "error");
    expect(registered.length).toBeGreaterThan(0);
    const [firstEvent, firstListener] = registered[0] ?? [];
    expect(firstEvent).toBe("error");
    expect(typeof firstListener).toBe("function");
  });
});
