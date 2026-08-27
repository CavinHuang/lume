import type { GuardedFetchDnsLookup, ResolvedAddress } from "../core/guarded-fetch";
import type { FetchMessageObject, ImapFlowOptions, MessageStructureObject, SearchObject } from "imapflow";
import type { LookupFunction, Socket, TcpNetConnectOpts } from "node:net";

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { Buffer } from "node:buffer";
import { connect as connectSocket } from "node:net";
import { join } from "node:path";
import nodemailer from "nodemailer";
import { createLogger } from "../../infra/logger";
import { resolveGuardedEgressTarget } from "../core/guarded-fetch";
import { isIpAddress } from "../core/request";
import { mailConnectionTimeoutMs, mailImapPort, mailSmtpPort } from "./config";
import { MailProtocolError, type MailProtocolErrorKind } from "./errors";

const logger = createLogger("connectors.mail.protocol");

export interface MailCredential {
  email: string;
  authorizationCode: string;
  imapHost: string;
  smtpHost: string;
  /**
   * Submission port, when the mailbox does not offer implicit TLS on 465.
   * Providers with a hardcoded host leave it unset and keep 465.
   */
  smtpPort?: number;
}

export interface MailProtocolConfig {
  displayName: string;
  attachmentFallbackPrefix: string;
  /**
   * Screen the resolved IP addresses of the mailbox hosts before connecting.
   * Enabled by default (#696): a save-time hostname check alone is defeated by
   * a DNS record that only points at an internal address once the connection
   * is made, so resolution and connection are pinned to the validated set.
   * Providers whose hosts are hardcoded as part of the integration may opt out
   * explicitly.
   */
  enforceHostNetworkPolicy?: boolean;
}

export interface MailSendInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  inReplyTo?: string;
  references?: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: MailOutgoingAttachment[];
}

export interface MailOutgoingAttachment {
  filename: string;
  contentType?: string;
  filePath: string;
}

export interface MailSendResult {
  messageId: string | null;
  accepted: string[];
  rejected: string[];
  response: string;
}

export interface MailFolder {
  path: string;
  name: string;
  delimiter: string | null;
  flags: string[];
  specialUse: string | null;
}

export interface MailSearchCriteria {
  unseen?: boolean;
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  since?: string;
  before?: string;
}

export interface MailSearchPage {
  limit: number;
  beforeUid?: number;
  peek: true;
}

export interface MailSearchSummariesResult {
  summaries: MailSummary[];
  nextBeforeUid: number | null;
}

export interface MailAddress {
  name: string | null;
  email: string | null;
}

export interface MailSummary {
  uid: number;
  messageId: string | null;
  subject: string | null;
  from: MailAddress | null;
  to: MailAddress[];
  date: string | null;
  flags: string[];
  seen: boolean;
  hasAttachments: boolean;
  size: number | null;
}

export interface MailAttachment {
  attachmentId: string;
  filename: string | null;
  contentType: string | null;
  size: number | null;
  contentId: string | null;
}

export interface MailFolderStatus {
  folder: string;
  messages: number | null;
  recent: number | null;
  unseen: number | null;
  uidNext: number | null;
  uidValidity: string | null;
}

export interface MailFetchedMessage {
  summary: MailSummary;
  /** Message-IDs to seed a reply's `References` header, oldest first. */
  references: string[];
  cc: MailAddress[];
  replyTo: MailAddress[];
  text: string | null;
  html: string | null;
  attachments: MailAttachment[];
  truncated: boolean;
}

export interface MailProtocol {
  /** waitSignal 只中止「排队等连接名额」阶段;名额到手后连接自身超时照旧。 */
  validateImapCredential(credential: MailCredential, waitSignal?: AbortSignal): Promise<void>;
  validateSmtpCredential(credential: MailCredential): Promise<void>;
  sendMail(credential: MailCredential, input: MailSendInput): Promise<MailSendResult>;
  listFolders(credential: MailCredential): Promise<MailFolder[]>;
  searchUids(credential: MailCredential, folder: string, criteria: MailSearchCriteria): Promise<number[]>;
  fetchSummaries(
    credential: MailCredential,
    folder: string,
    uids: number[],
    options: { peek: true },
  ): Promise<MailSummary[]>;
  searchSummaries(
    credential: MailCredential,
    folder: string,
    criteria: MailSearchCriteria,
    page: MailSearchPage,
  ): Promise<MailSearchSummariesResult>;
  fetchMessage(
    credential: MailCredential,
    folder: string,
    uid: number,
    options: { peek: true; maxBytes: number; skipAttachmentBodies: true },
  ): Promise<MailFetchedMessage>;
  markSeen(credential: MailCredential, folder: string, uid: number): Promise<void>;
  markUnseen(credential: MailCredential, folder: string, uid: number): Promise<void>;
  moveMessage(credential: MailCredential, folder: string, uid: number, targetFolder: string): Promise<void>;
  /** Move the message into the server's \Trash folder; returns the Trash path. */
  deleteMessage(credential: MailCredential, folder: string, uid: number): Promise<string>;
  getFolderStatus(credential: MailCredential, folder: string): Promise<MailFolderStatus>;
}

export interface MailProtocolDependencies {
  createSmtpTransport?: (config: Record<string, unknown>) => MailSmtpTransport;
  createImapClient?: (config: Record<string, unknown>) => MailImapClient;
  lookup?: GuardedFetchDnsLookup;
  connectSocket?: (options: TcpNetConnectOpts) => Socket;
  /** 时钟注入:池化连接的空闲 TTL 判定用,测试可控。 */
  now?: () => number;
}

interface MailSmtpTransport {
  verify(): Promise<unknown>;
  sendMail(input: Record<string, unknown>): Promise<{
    messageId?: string;
    accepted?: unknown[];
    rejected?: unknown[];
    response?: string;
  }>;
  close(): void;
}

interface MailImapClient {
  connect(): Promise<void>;
  logout(): Promise<void>;
  close?(): void;
  list(): Promise<unknown[]>;
  /** imapflow extends EventEmitter;fake 实现可不提供。 */
  on?(event: "error", listener: (error: Error) => void): unknown;
}

type RuntimeImapClient = MailImapClient & {
  mailboxOpen(path: string, options: { readOnly: boolean }): Promise<unknown>;
  search(query: SearchObject, options: { uid: true }): Promise<number[] | false>;
  fetchAll(range: number[], query: Record<string, unknown>, options: { uid: true }): Promise<unknown[]>;
  fetchOne(uid: number, query: Record<string, unknown>, options: { uid: true }): Promise<unknown | false>;
  messageFlagsAdd(range: number[], flags: string[], options: { uid: true }): Promise<boolean>;
  messageFlagsRemove(range: number[], flags: string[], options: { uid: true }): Promise<boolean>;
  messageMove(range: number[], targetFolder: string, options: { uid: true }): Promise<unknown | false>;
  messageDelete(range: number[], options: { uid: true }): Promise<boolean>;
  status(
    folder: string,
    query: {
      messages: true;
      recent: true;
      unseen: true;
      uidNext: true;
      uidValidity: true;
    },
  ): Promise<unknown>;
};

interface BodyPart {
  part: string;
  type: string;
  parameters: Record<string, string>;
  encoding: string | null;
  size: number | null;
}

/**
 * 已观测的邮箱状态(账号+文件夹 → UIDVALIDITY)。读动作建立基准,写动作前比对:
 * 文件夹被删除重建后 UID 计数器归位,上轮记住的 UID N 与本轮的 UID N 是两封不同
 * 邮件——叠加删除类动作为不可逆操作,过期 UID 的后果不可恢复。进程级缓存同时
 * 覆盖同会话中途重建与 sidecar 重启后凭旧记忆直写的两个窗口。
 */
const observedMailboxUidValidity = new Map<string, string>();

function mailboxStateKey(email: string, folder: string): string {
  // 与连接闸门(#698)同口径:同一物理邮箱的大小写变体共享 UIDVALIDITY 基准,
  // 否则混合大小写写入的基准对后续比对不可见,fail-closed 会误拒合法动作
  return `${email.toLowerCase()}\0${folder}`;
}

export function createMailProtocol(config: MailProtocolConfig, deps: MailProtocolDependencies = {}): MailProtocol {
  return {
    async validateImapCredential(credential, waitSignal) {
      await withImapClient(
        config,
        deps,
        credential,
        async (client) => {
          await client.list();
        },
        { waitSignal },
      );
    },
    async validateSmtpCredential(credential) {
      const transport = await createSmtpTransport(config, deps, credential);
      try {
        await transport.verify();
      } catch (error) {
        throw mapLibraryError(error, config);
      } finally {
        transport.close();
      }
    },
    async sendMail(credential, input) {
      const transport = await createSmtpTransport(config, deps, credential);
      try {
        const result = await transport.sendMail({
          from: credential.email,
          to: input.to,
          ...(input.cc ? { cc: input.cc } : {}),
          ...(input.bcc ? { bcc: input.bcc } : {}),
          ...(input.replyTo ? { replyTo: input.replyTo } : {}),
          ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
          ...(input.references ? { references: input.references } : {}),
          subject: input.subject,
          ...(input.text !== undefined ? { text: input.text } : {}),
          ...(input.html !== undefined ? { html: input.html } : {}),
          ...(input.attachments
            ? {
                attachments: input.attachments.map((attachment) => ({
                  filename: attachment.filename,
                  ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
                  path: attachment.filePath,
                })),
              }
            : {}),
        });
        return {
          messageId: typeof result.messageId === "string" ? result.messageId : null,
          accepted: normalizeStringArray(result.accepted),
          rejected: normalizeStringArray(result.rejected),
          response: typeof result.response === "string" ? result.response : "",
        };
      } catch (error) {
        throw mapLibraryError(error, config);
      } finally {
        transport.close();
      }
    },
    async listFolders(credential) {
      return await withImapClient(config, deps, credential, async (client) =>
        (await client.list()).map(normalizeMailbox),
      );
    },
    async searchUids(credential, folder, criteria) {
      return await withMailbox(config, deps, credential, folder, true, async (client) => {
        return await searchUidsInMailbox(client, criteria);
      });
    },
    async fetchSummaries(credential, folder, uids) {
      return await withMailbox(config, deps, credential, folder, true, async (client) => {
        return await fetchSummariesInMailbox(client, uids);
      });
    },
    async searchSummaries(credential, folder, criteria, page) {
      return await withMailbox(config, deps, credential, folder, true, async (client) => {
        const uids = await searchUidsInMailbox(client, criteria);
        const { returnedUids, nextBeforeUid } = pageUids(uids, page.limit, page.beforeUid);
        return {
          summaries: await fetchSummariesInMailbox(client, returnedUids),
          nextBeforeUid,
        };
      });
    },
    async fetchMessage(credential, folder, uid, options) {
      return await withMailbox(config, deps, credential, folder, true, async (client) => {
        const metadata = await client.fetchOne(
          uid,
          {
            uid: true,
            envelope: true,
            flags: true,
            size: true,
            bodyStructure: true,
            // The IMAP envelope carries no thread headers, so a reply can only
            // continue the thread if they are fetched alongside it.
            headers: ["references", "in-reply-to"],
          },
          { uid: true },
        );
        if (!metadata) {
          throw new MailProtocolError("uid_not_found", "Mail message UID does not exist in the selected folder.");
        }

        const message = metadata as FetchMessageObject;
        const selectedParts = selectBodyParts(message.bodyStructure, options.maxBytes);
        const bodyFetch =
          selectedParts.length === 0
            ? false
            : await client.fetchOne(
                uid,
                {
                  bodyParts: selectedParts.map(({ part, maxLength }) => ({
                    key: part.part,
                    maxLength,
                  })),
                },
                { uid: true },
              );
        const parsedBody = await parseSelectedBodyParts(selectedParts, bodyFetch);

        return {
          summary: normalizeSummary(message),
          references: readReferences(toRecord(message)?.headers),
          cc: normalizeEnvelopeAddresses(message, "cc"),
          replyTo: normalizeEnvelopeAddresses(message, "replyTo"),
          text: parsedBody.text,
          html: parsedBody.html,
          attachments: collectAttachmentMetadata(message.bodyStructure),
          truncated: parsedBody.truncated,
        };
      });
    },
    async markSeen(credential, folder, uid) {
      await withMailbox(config, deps, credential, folder, false, async (client) => {
        await requireMessageExists(client, uid);
        const updated = await client.messageFlagsAdd([uid], ["\\Seen"], { uid: true });
        if (!updated) {
          throw new MailProtocolError("uid_not_found", "Mail message UID does not exist in the selected folder.");
        }
      });
    },
    async markUnseen(credential, folder, uid) {
      await withMailbox(config, deps, credential, folder, false, async (client) => {
        await requireMessageExists(client, uid);
        const updated = await client.messageFlagsRemove([uid], ["\\Seen"], { uid: true });
        if (!updated) {
          throw new MailProtocolError("uid_not_found", "Mail message UID does not exist in the selected folder.");
        }
      });
    },
    async moveMessage(credential, folder, uid, targetFolder) {
      await withMailbox(config, deps, credential, folder, false, async (client) => {
        await requireMessageExists(client, uid);
        const moved = await moveMessageToFolder(client, uid, targetFolder);
        if (!moved) {
          throw new MailProtocolError("uid_not_found", "Mail message UID does not exist in the selected folder.");
        }
      });
    },
    async deleteMessage(credential, folder, uid) {
      return await withMailbox(config, deps, credential, folder, false, async (client) => {
        await requireMessageExists(client, uid);
        // 语义对齐 Gmail move_to_trash:移入 \Trash 可恢复,而非标记 \Deleted
        // 后 EXPUNGE 物理删除(用户一次审批即不可逆)。服务器无 \Trash 时拒绝
        // 执行而非退回硬删。
        const trash = (await client.list())
          .map(normalizeMailbox)
          .find((mailbox) => mailbox.specialUse === "\\Trash");
        if (!trash) {
          throw new MailProtocolError(
            "trash_missing",
            "This server has no Trash folder; the message was left untouched instead of being permanently deleted.",
          );
        }
        const moved = await moveMessageToFolder(client, uid, trash.path);
        if (!moved) {
          throw new MailProtocolError("uid_not_found", "Mail message UID does not exist in the selected folder.");
        }
        return trash.path;
      });
    },
    async getFolderStatus(credential, folder) {
      return await withImapClient(
        config,
        deps,
        credential,
        async (client) => {
        const status = toRecord(
          await client.status(folder, {
            messages: true,
            recent: true,
            unseen: true,
            uidNext: true,
            uidValidity: true,
          }),
        );
        // 与 withMailbox 读路径同权:显式查状态也建立写前比对基准
        const uidValidity = readBigIntString(status?.uidValidity);
        if (uidValidity !== null) {
          observedMailboxUidValidity.set(mailboxStateKey(credential.email, folder), uidValidity);
        }
        return {
          folder,
          messages: readInteger(status?.messages),
          recent: readInteger(status?.recent),
          unseen: readInteger(status?.unseen),
          uidNext: readInteger(status?.uidNext),
          uidValidity: readBigIntString(status?.uidValidity),
        };
        },
        // RFC 3501 §6.3.10 对向选中邮箱发 STATUS 仅是 SHOULD NOT(\Recent/
        // unseen 口径服务器分歧大),QQ 类口径不可控,池化后借出的连接
        // 可能带着上一个动作 mailboxOpen 的选中态,必须要求非 selected
        { requireUnselected: true },
      );
    },
  };
}

/**
 * 变更类动作的存在性前置探测。imapflow 的 store/expunge/move 收到服务器 OK 即返回
 * true,而 RFC 3501 的 UID STORE/EXPUNGE/MOVE 对不存在的 UID 静默成功——不能靠
 * 它们的返回值判 existence,否则过期 UID 会虚报"已读/已删除/已移动"。
 */
async function requireMessageExists(client: RuntimeImapClient, uid: number): Promise<void> {
  const found = await client.fetchOne(uid, { uid: true }, { uid: true });
  if (!found) {
    throw new MailProtocolError("uid_not_found", "Mail message UID does not exist in the selected folder.");
  }
}

async function moveMessageToFolder(client: RuntimeImapClient, uid: number, targetFolder: string) {
  try {
    return await client.messageMove([uid], targetFolder, { uid: true });
  } catch (error) {
    if (isFolderMissingError(error)) {
      throw new MailProtocolError("folder_not_found", "Mail folder does not exist.");
    }
    throw error;
  }
}

interface MailHostTarget {
  host: string;
  servername?: string;
  lookup?: LookupFunction;
}

async function pinMailHost(
  host: string,
  fieldName: string,
  config: MailProtocolConfig,
  deps: MailProtocolDependencies,
): Promise<MailHostTarget> {
  // 默认启用(#696):仅硬编码 host 的内置 provider 显式豁免
  if (config.enforceHostNetworkPolicy === false) {
    return { host };
  }

  const target = await resolveGuardedEgressTarget(`https://${host}`, {
    fieldName,
    createError: (message) => new MailProtocolError("blocked_host", message),
    createResolutionError: (message) => new MailProtocolError("network", message),
    lookup: deps.lookup,
  });
  if (target.addresses.length === 0) {
    throw new MailProtocolError("network", `${fieldName} could not be resolved for validation.`);
  }
  return {
    host: target.url.hostname,
    ...(!isIpAddress(target.url.hostname) ? { servername: target.url.hostname } : {}),
    lookup: createPinnedLookup(target.addresses),
  };
}

function createPinnedLookup(addresses: ResolvedAddress[]): LookupFunction {
  return ((_hostname, options, callback) => {
    if (typeof options === "object" && options.all) {
      callback(null, addresses);
      return;
    }
    const first = addresses[0]!;
    callback(null, first.address, first.family);
  }) as LookupFunction;
}

async function createSmtpTransport(
  config: MailProtocolConfig,
  deps: MailProtocolDependencies,
  credential: MailCredential,
): Promise<MailSmtpTransport> {
  const target = await pinMailHost(credential.smtpHost, "SMTP host", config, deps);
  const port = credential.smtpPort ?? mailSmtpPort;
  const transportConfig = {
    host: target.host,
    ...(target.servername ? { servername: target.servername } : {}),
    port,
    ...(target.lookup ? { getSocket: createSmtpSocketFactory(target.host, port, target.lookup, deps) } : {}),
    // Implicit TLS is the wire convention on 465 only. Every other submission
    // port starts in cleartext and upgrades, so STARTTLS is demanded rather than
    // taken opportunistically: nodemailer then aborts instead of sending the
    // password in the clear to a server that does not offer the upgrade. The
    // flag stays off for implicit TLS, where it would only make a server whose
    // EHLO fails unusable rather than falling back to HELO as before.
    secure: port === mailSmtpPort,
    requireTLS: port !== mailSmtpPort,
    auth: {
      user: credential.email,
      pass: credential.authorizationCode,
    },
    connectionTimeout: mailConnectionTimeoutMs,
    greetingTimeout: mailConnectionTimeoutMs,
    socketTimeout: mailConnectionTimeoutMs,
  };

  return deps.createSmtpTransport
    ? deps.createSmtpTransport(transportConfig)
    : (nodemailer.createTransport(transportConfig as never) as MailSmtpTransport);
}

async function createImapClient(
  config: MailProtocolConfig,
  deps: MailProtocolDependencies,
  credential: MailCredential,
): Promise<MailImapClient> {
  const target = await pinMailHost(credential.imapHost, "IMAP host", config, deps);
  const clientConfig = {
    host: target.host,
    ...(target.servername ? { servername: target.servername } : {}),
    ...(target.lookup ? { tls: { lookup: target.lookup, autoSelectFamily: true } } : {}),
    port: mailImapPort,
    secure: true,
    auth: {
      user: credential.email,
      pass: credential.authorizationCode,
    },
    connectionTimeout: mailConnectionTimeoutMs,
    greetingTimeout: mailConnectionTimeoutMs,
    socketTimeout: mailConnectionTimeoutMs,
    logger: false,
  };

  const client = deps.createImapClient
    ? deps.createImapClient(clientConfig)
    : new ImapFlow(clientConfig as ImapFlowOptions);
  // imapflow 的传输层异步错误(socket RST/TLS alert/命令超时中断)在 connect settle
  // 后经 emit("error") 抛出;EventEmitter 无监听会升级为进程级 uncaughtException,
  // 累计触发 sidecar 兜底退出——必须常挂兜底监听。
  client.on?.("error", (error: Error) => {
    logger.warn("imap client transport error", { error: error.message });
  });
  return client;
}

function createSmtpSocketFactory(host: string, port: number, lookup: LookupFunction, deps: MailProtocolDependencies) {
  return (_options: unknown, callback: (error: Error | null, options?: { connection: Socket }) => void): void => {
    const socket = (deps.connectSocket ?? connectSocket)({ host, port, lookup, autoSelectFamily: true });
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      socket.removeListener("timeout", onTimeout);
      socket.setTimeout(0);
      callback(error ?? null, error ? undefined : { connection: socket });
    };
    const onConnect = (): void => finish();
    const onError = (error: Error): void => finish(error);
    const onTimeout = (): void => {
      const error = new Error("Connection timeout") as NodeJS.ErrnoException;
      error.code = "ETIMEDOUT";
      socket.destroy();
      finish(error);
    };

    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    socket.setTimeout(mailConnectionTimeoutMs);
  };
}

/**
 * QQ 等服务商对单账号并发 IMAP 连接数有上限(#698):协议层一动作一连接,
 * agent 并行调用只读工具(search_emails + 多个 get_email)会各开一条连接撞限,
 * 超限报错形如 "LOGIN failed" 又会被 isAuthError 启发式误判成授权码失效。
 * 按账号把在途连接压到上限之下;排队即预占名额,唤醒者恢复后直接运行。
 */
export const maxImapConnectionsPerAccount = 2;

/**
 * 单账号排队深度上限(#698 审查 P2):超限快败而非无限堆积。engine 单轮
 * 并发 ≤10(MAX_CONCURRENCY 默认),32 已为多会话叠加留足余量;触发即说明
 * 服务端已不可达或调用方失控,挂死排队不如立刻把「稍后重试」还给模型。
 */
export const maxImapWaitersPerAccount = 32;

/**
 * 池化连接的最长空闲复用窗口(#698 后续:连接复用)。惰性判定(借出时检查),
 * 无后台定时器。真实存活上界并非服务端踢线,而是 min(本地 socketTimeout=30s
 * 看门狗, 服务端踢线):SELECTED 态连接有 imapflow auto-IDLE 心跳近乎永生,
 * AUTHENTICATED 态(list/status/验证族归还)30s 即被本地看门狗关闭——该场景
 * 由建连时挂载的 error 监听置 dead 标记兜住,借出时统一淘汰。本 TTL 因此
 * 只是资源释放手段,不是活性保证;60s 覆盖 agent 一轮突发多动作的节奏。
 */
export const imapIdleReuseTtlMs = 60_000;

interface PooledImapConnection {
  client: RuntimeImapClient;
  idledAt: number;
  /** 建连时的 IMAP host:用户更改 host 设置后旧连接不得跨 host 复用。 */
  host: string;
  /** 建连时的授权码快照:凭证轮换后旧会话不得冒充新凭证通过验证。 */
  authCode: string;
  /** imapflow emit error(watchdog 超时/socket 故障)后置位,借出前必须淘汰。 */
  dead?: boolean;
}

interface ImapAccountGate {
  active: number;
  waiters: Array<() => void>;
  /** 空闲可复用的池化连接(容量受 maxImapConnectionsPerAccount 约束)。 */
  idle: PooledImapConnection[];
}

const imapAccountGates = new Map<string, ImapAccountGate>();

// ---------------------------------------------------------------------------
// 池可观测性(#784①):分类计数器 + 只读快照。没有它「池在工作吗」「LOGIN
// 频率下降多少」无法在线验证(#768 性能审查的量化数字只能离线建模)。
// 协议层是模块级单例,计数器与日志同为进程级口径,不做 per-request 归因。
// 字段名沿 issue 台账/日志的 snake_case 口径(与文件内 TS camelCase 并存),
// 三个载体词汇统一优先于本文件命名惯例。
// 口径:全部为**事件数**而非连接数——同一条死连接先记 error_destroy(监听侧
// 补刀)再记 miss_dead(借出淘汰)是两次事件,不是双计入错;消费时勿按
// 「销毁连接数 = error_destroy + Σmiss_*」换算。命中率 = pool_hit /
// (pool_hit + created),miss_* 只作归因不作分母。
// ---------------------------------------------------------------------------

interface ImapPoolMetrics {
  /** 借出命中池内兼容连接。 */
  pool_hit: number;
  /** 新建连接成功(= LOGIN 次数,衡量复用收益的直接口径)。 */
  created: number;
  /** 借出/清扫时超过空闲 TTL。 */
  miss_ttl: number;
  /** 借出/清扫时发现 dead 标记置位(看门狗/socket 故障)。 */
  miss_dead: number;
  /** 借出时 IMAP host 与建连时不符(host 设置变更)。 */
  miss_host: number;
  /** 借出时授权码与建连时不符(凭证轮换)。 */
  miss_auth: number;
  /** 借出时要求非 selected 态但候选已被 EXAMINE(getFolderStatus 路径)。 */
  miss_unselected: number;
  /** 动作失败或 error 事件导致的销毁(坏连接绝不回流池中)。 */
  error_destroy: number;
}

const imapPoolMetrics: ImapPoolMetrics = {
  pool_hit: 0,
  created: 0,
  miss_ttl: 0,
  miss_dead: 0,
  miss_host: 0,
  miss_auth: 0,
  miss_unselected: 0,
  error_destroy: 0,
};

/**
 * #784① 只读快照:计数器副本 + 池内空闲条目数(全账号)。生产观测导出
 * (非测试专用):事件数口径见上方分节注释;idle_connections 是池数组条目数,
 * 含尚未被惰性清扫摘除的 dead 条目,是可复用容量的上界而非精确值。
 */
export interface ImapPoolMetricsSnapshot extends Readonly<ImapPoolMetrics> {
  idle_connections: number;
  /** error_destroy 的 kind 细分(#784②/#790):watchdog 与 mapLibraryError kind 同表,事件数口径。 */
  error_destroy_kinds: Record<string, number>;
}

const imapErrorDestroyKinds = new Map<string, number>();

export function imapPoolMetricsSnapshot(): ImapPoolMetricsSnapshot {
  let idle = 0;
  for (const gate of imapAccountGates.values()) {
    idle += gate.idle.length;
  }
  return {
    ...imapPoolMetrics,
    idle_connections: idle,
    error_destroy_kinds: Object.fromEntries(imapErrorDestroyKinds),
  };
}

const poolLogger = createLogger("connectors.mail.protocol");

/**
 * 计数并留 debug 轨:dev trace 下可逐事件回放,生产默认零噪音。
 * kind 供 error_destroy 细分(#784② 的论证数据:本地判定错 vs 网络错占比,
 * mapLibraryError 的 kind 或 create/monitor 事件源),仅进日志不进计数器。
 */
function bumpPoolMetric(metric: keyof ImapPoolMetrics, kind?: string): void {
  imapPoolMetrics[metric] += 1;
  if (metric === "error_destroy" && kind) {
    // #784②/#790:本地判定错 vs 网络错占比的论证数据。此前只进 debug 日志,
    // fileLevel=info 下生产拿不到——改为进程级累计随快照出口。
    imapErrorDestroyKinds.set(kind, (imapErrorDestroyKinds.get(kind) ?? 0) + 1);
  }
  poolLogger.debug("imap pool metric", { metric, total: imapPoolMetrics[metric], ...(kind ? { kind } : {}) });
}

/**
 * 排队等待一个连接名额;waitSignal 在排队阶段中止时退队并归还预占名额,
 * 以 signal.reason(或缺省 provider 错误)reject。
 */
async function awaitImapSlot(gate: ImapAccountGate, waitSignal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const leaveQueueWithoutSlot = () => {
      const index = gate.waiters.indexOf(wake);
      if (index < 0) {
        // 从未入队(携带已中止 signal 直达):本方未记过账,不退任何名额
        return;
      }
      gate.waiters.splice(index, 1);
      // 只退自己的预占,不放行队头:排队者的名额是「虚」的——它从未建连,
      // 退出没有释放任何服务端容量;若在此 shift 转交,后继会立即建连使真实
      // 连接数突破上限(#698 二轮审查实测复现)。放行只属于释放路径的真实
      // active-- 配对,FIFO 由「waiters>0 ⇒ active≥max」不变式保持。
      gate.active -= 1;
    };
    const onAbort = () => {
      leaveQueueWithoutSlot();
      reject(waitSignal?.reason ?? new MailProtocolError("provider", "aborted while waiting for a connection slot"));
    };
    const wake = () => {
      waitSignal?.removeEventListener("abort", onAbort);
      resolve();
    };

    if (waitSignal?.aborted) {
      onAbort();
      return;
    }
    waitSignal?.addEventListener("abort", onAbort, { once: true });
    // 排队即预占名额(active 含排队者):唤醒者恢复后直接运行、不再复查,
    // 晚到者必见 active≥max 而入队,无法插队超发。守恒依赖此约定——
    // 若改成「唤醒后补记」,排队窗口内的新到达会读到偏小的 active 造成超限。
    gate.active += 1;
    gate.waiters.push(wake);
  });
}

async function withImapConnectionLimit<T>(
  account: string,
  run: () => Promise<T>,
  waitSignal?: AbortSignal,
): Promise<T> {
  let gate = imapAccountGates.get(account);
  if (!gate) {
    gate = { active: 0, waiters: [], idle: [] };
    imapAccountGates.set(account, gate);
  }
  if (gate.active >= maxImapConnectionsPerAccount) {
    if (gate.waiters.length >= maxImapWaitersPerAccount) {
      // busy 而非 provider:请求未发往上游,是本地主动快败,模型应退避重试;
      // message 不嵌 email——调用结果天然绑定发起上下文,且 email 不进错误面
      throw new MailProtocolError("busy", "Too many pending operations for this account; retry shortly.");
    }
    // 中止路径在 awaitImapSlot 内部已退队并还原名额,此处直接向上抛
    await awaitImapSlot(gate, waitSignal);
  } else {
    gate.active += 1;
  }
  try {
    return await run();
  } finally {
    gate.active -= 1;
    gate.waiters.shift()?.();
    // 预占模型下被放行者仍计在 active 中,active===0 蕴含无人持有此 gate。
    // idle 池非空时保留条目:池化连接等待复用,由 TTL 惰性判定自然消化
    if (gate.active === 0 && gate.waiters.length === 0 && gate.idle.length === 0) {
      imapAccountGates.delete(account);
    }
  }
}

/** 仅供不变式测试观察闸门生命周期:idle 为当前待复用的池化连接数。 */
export function imapAccountGateStateForTest(
  email: string,
): { active: number; waiting: number; idle: number } | undefined {
  const gate = imapAccountGates.get(email.toLowerCase());
  return gate ? { active: gate.active, waiting: gate.waiters.length, idle: gate.idle.length } : undefined;
}

/**
 * 借出选项:waitSignal 只作用于排队段;requireUnselected 见 getFolderStatus。
 * 红线:callback 内严禁再调同账号协议方法——嵌套租借会占满名额自等,永久死锁。
 */
interface ImapLeaseOptions {
  waitSignal?: AbortSignal;
  /**
   * RFC 3501 §6.3.10 对「向当前选中的邮箱发 STATUS」仅是 SHOULD NOT(语义在
   * \Recent/unseen 口径上服务器分歧大),非硬禁止——但 QQ 类服务器的口径不可控,
   * 池化复用会让 STATUS 撞上上一动作 EXAMINE 过的连接,故 getFolderStatus 要求
   * 一条非 selected 连接(或新建)。演进项:借出后 CLOSE(一次 RTT)替代驱逐重建。
   */
  requireUnselected?: boolean;
}

/**
 * 搭车清扫:TTL/dead 判定是借出侧逻辑,沉寂账号的池内连接永远不会被
 * 「下一次借出」触达——SELECTED 态更有 auto-IDLE 心跳近乎永生,明文授权码
 * 与已认证服务端会话因此进程级滞留并持续占用服务端并发名额(#698 的稀缺
 * 资源本身)。每次进入闸门前顺手扫一遍全表空闲条目,O(账号数) 摊销可忽略,
 * 免掉后台定时器;活跃/有排队者的 gate 不动。
 */
function sweepStaleIdleConnections(now: () => number) {
  for (const [account, gate] of imapAccountGates) {
    if (gate.active > 0 || gate.waiters.length > 0 || gate.idle.length === 0) {
      continue;
    }
    gate.idle = gate.idle.filter((conn) => {
      const stale = conn.dead || now() - conn.idledAt > imapIdleReuseTtlMs;
      if (stale) {
        bumpPoolMetric(conn.dead ? "miss_dead" : "miss_ttl");
        destroyPooledClient(conn.client);
      }
      return !stale;
    });
    if (gate.idle.length === 0) {
      imapAccountGates.delete(account);
    }
  }
}

/**
 * 业务语义错:错误源自操作对象不存在或服务器端邮箱状态变化(folder/uid/trash/
 * UIDVALIDITY),而非连接本身——销毁会误杀健康会话(#784① P1)。其余 kind
 * (auth/timeout/network/provider)意味着传输层可疑,照旧一律销毁。
 */
const BUSINESS_ERROR_KINDS: ReadonlySet<MailProtocolErrorKind> = new Set([
  "folder_not_found",
  "uid_not_found",
  "trash_missing",
  "uid_validity_changed",
]);

async function withImapClient<T>(
  config: MailProtocolConfig,
  deps: MailProtocolDependencies,
  credential: MailCredential,
  callback: (client: RuntimeImapClient) => Promise<T>,
  options: ImapLeaseOptions = {},
) {
  sweepStaleIdleConnections(deps.now ?? Date.now);
  return withImapConnectionLimit(
    credential.email.toLowerCase(),
    async () => {
      const gate = imapAccountGates.get(credential.email.toLowerCase())!;
      const conn = await acquirePooledClient(config, deps, credential, gate, options);
      // 归还出口(成功与业务错共用):被看门狗杀死的连接(dead 置位)绝不回流
      const release = () => {
        if (conn.dead) {
          destroyPooledClient(conn.client);
        } else {
          conn.idledAt = (deps.now ?? Date.now)();
          gate.idle.push(conn);
        }
      };
      try {
        const result = await callback(conn.client);
        release();
        return result;
      } catch (error) {
        const mapped = mapLibraryError(error, config);
        if (BUSINESS_ERROR_KINDS.has(mapped.kind)) {
          release();
        } else {
          bumpPoolMetric("error_destroy", mapped.kind);
          destroyPooledClient(conn.client);
        }
        throw mapped;
      }
    },
    options.waitSignal,
  );
}

/**
 * 借出一条连接:线性扫描池内全部候选(≤max 条),取第一条兼容者,不兼容的
 * 就地销毁——单候选 LIFO pop 会让压在栈底的死/过期连接永无出头之日。
 * 候选必须同时满足未死亡、host 与授权码未变、未过 TTL、(按需)非 selected 态,
 * 否则同步 close 销毁——绝不用 fire-and-forget LOGOUT 驱逐,其 RTT 窗口会与
 * 紧随的新 LOGIN 在服务端叠加成 cap+1 会话(#698 要消灭的超限误判模式)。
 */
async function acquirePooledClient(
  config: MailProtocolConfig,
  deps: MailProtocolDependencies,
  credential: MailCredential,
  gate: ImapAccountGate,
  options: ImapLeaseOptions,
): Promise<PooledImapConnection> {
  const now = deps.now ?? Date.now;
  let reusable: PooledImapConnection | undefined;
  while (gate.idle.length > 0 && !reusable) {
    const candidate = gate.idle.pop()!;
    const expired = now() - candidate.idledAt > imapIdleReuseTtlMs;
    if (
      !candidate.dead &&
      candidate.host === credential.imapHost &&
      candidate.authCode === credential.authorizationCode &&
      !(options.requireUnselected && hasSelectedMailbox(candidate.client)) &&
      !expired
    ) {
      reusable = candidate;
    } else {
      // 判定顺序即分类优先级:dead 最优先(最危险);expired 在 host/auth 之前,
      // 高频 TTL 会掩盖低频 host/auth 失配的可见性——读 miss_host/miss_auth
      // 时需知并发场景下被 TTL 先行吸收(#784① review)
      bumpPoolMetric(
        candidate.dead
          ? "miss_dead"
          : expired
            ? "miss_ttl"
            : candidate.host !== credential.imapHost
              ? "miss_host"
              : candidate.authCode !== credential.authorizationCode
                ? "miss_auth"
                : "miss_unselected",
      );
      destroyPooledClient(candidate.client);
    }
  }

  if (reusable) {
    bumpPoolMetric("pool_hit");
    return reusable;
  }

  let fresh: MailImapClient;
  try {
    fresh = await createImapClient(config, deps, credential);
  } catch (error) {
    // DNS 解析失败/host 策略拦截:client 尚未建连,无物可销毁;计数使
    // pool_hit + created + Σmiss_* 的借出账目闭合,kind 区分阻断成因
    const mapped = mapLibraryError(error, config);
    bumpPoolMetric("error_destroy", mapped.kind);
    throw mapped;
  }
  const conn: PooledImapConnection = {
    client: fresh as RuntimeImapClient,
    idledAt: 0,
    host: credential.imapHost,
    authCode: credential.authorizationCode,
  };
  // 监听必须先于 connect 挂载:connect 未决期 imapflow 走 initialReject 不
  // emit(error),但那是上游实现细节;先挂载把安全性变成结构保证
  attachDeadMarker(conn);
  try {
    await fresh.connect();
  } catch (error) {
    // 监听侧若已在 connect 决算窗口内置位 dead(emit+reject 同达的假想上游),
    // 计数与补刀都归它——此处不再重复记 error_destroy(事件数口径)
    if (!conn.dead) {
      const mapped = mapLibraryError(error, config);
      bumpPoolMetric("error_destroy", mapped.kind);
      destroyPooledClient(conn.client);
    }
    throw mapLibraryError(error, config);
  }
  bumpPoolMetric("created");
  return conn;
}

/**
 * imapflow 对空闲超时/socket 故障会 emit("error")(AUTHENTICATED 态无
 * auto-IDLE 保活,30s 看门狗必触发),而库内外无人监听——Node 对无监听者
 * 的 error emit 同步抛 uncaughtException(sidecar 计次 5 次自杀)。
 *
 * 监听必须在 connect() 决算前挂载:imapflow 的 connect 未决期错误走
 * initialReject 不 emit(error),但那是库内实现细节而非结构保证;new 之后
 * 立即挂载把安全性从「上游善意」变成「本文件结构」。监听置 dead 标记供
 * 借出淘汰,并就地补刀 close(imapflow 自身 closeAfter 已关,幂等)防止
 * 死 socket 在被再次借出前滞留 fd与服务端会话名额;命令级失败仍由
 * run() 正常上抛。
 */
function attachDeadMarker(conn: PooledImapConnection) {
  const emitter = conn.client as unknown as {
    on?: (event: string, listener: () => void) => void;
  };
  if (typeof emitter.on !== "function") {
    // 缺 on 的自定义注入会让 dead 标记失效,行为无声退回
    // 「空闲 emit error → uncaughtException」的原 P0——宁可吵闹不可静默
    console.warn("[mail] pooled IMAP client does not support on(); dead-marking disabled");
    return;
  }
  emitter.on("error", () => {
    if (conn.dead) return;
    conn.dead = true;
    // imapflow 自身 closeAfter 已关 socket,此处补刀幂等;防止死 socket
    // 在被再次借出前滞留 fd 与服务端会话名额
    bumpPoolMetric("error_destroy", "watchdog");
    destroyPooledClient(conn.client);
  });
}

function hasSelectedMailbox(client: RuntimeImapClient): boolean {
  return Boolean((client as unknown as { mailbox?: unknown }).mailbox);
}

/**
 * 连接终结的统一出口:同步 close 销毁。close 是清理兜底,自身失败不得
 * 抛出——socket 资源由进程回收。
 */
function destroyPooledClient(client: RuntimeImapClient) {
  try {
    client.close?.();
  } catch {
    /* 清理兜底的失败无诊断价值 */
  }
}

async function withMailbox<T>(
  config: MailProtocolConfig,
  deps: MailProtocolDependencies,
  credential: MailCredential,
  folder: string,
  readOnly: boolean,
  callback: (client: RuntimeImapClient) => Promise<T>,
) {
  return await withImapClient(config, deps, credential, async (client) => {
    let opened: Record<string, unknown> | null;
    try {
      opened = toRecord(await client.mailboxOpen(folder, { readOnly }));
    } catch (error) {
      if (isFolderMissingError(error)) {
        throw new MailProtocolError("folder_not_found", "Mail folder does not exist.");
      }
      throw error;
    }

    const uidValidity = readBigIntString(opened?.uidValidity);
    if (uidValidity !== null) {
      const key = mailboxStateKey(credential.email, folder);
      const known = observedMailboxUidValidity.get(key);
      if (!readOnly) {
        // 变更类动作 fail-closed:基准缺失(进程重启后凭旧记忆直写)或失配
        // (文件夹重建致计数器重置)都拒绝,要求重新 search 建立新鲜基准
        if (known === undefined) {
          throw new MailProtocolError(
            "uid_validity_changed",
            `No mailbox state observed for this folder in the current session. Run search_emails first and retry with fresh UIDs.`,
          );
        }
        if (known !== uidValidity) {
          throw new MailProtocolError(
            "uid_validity_changed",
            `The folder was recreated or reset (UIDVALIDITY changed): UIDs from earlier searches are stale. Re-run search_emails and retry with fresh UIDs.`,
          );
        }
      }
      observedMailboxUidValidity.set(key, uidValidity);
    }

    return await callback(client);
  });
}

function createSearchQuery(criteria: MailSearchCriteria): SearchObject {
  const query: SearchObject = {};
  if (criteria.unseen === true) {
    query.seen = false;
  }
  if (criteria.from) {
    query.from = criteria.from;
  }
  if (criteria.to) {
    query.to = criteria.to;
  }
  if (criteria.subject) {
    query.subject = criteria.subject;
  }
  if (criteria.text) {
    query.body = criteria.text;
  }
  if (criteria.since) {
    query.since = criteria.since;
  }
  if (criteria.before) {
    query.before = criteria.before;
  }

  return Object.keys(query).length === 0 ? { all: true } : query;
}

async function searchUidsInMailbox(client: RuntimeImapClient, criteria: MailSearchCriteria) {
  const result = await client.search(createSearchQuery(criteria), { uid: true });
  return result === false ? [] : result.filter((uid) => Number.isInteger(uid) && uid > 0);
}

async function fetchSummariesInMailbox(client: RuntimeImapClient, uids: number[]) {
  if (uids.length === 0) {
    return [];
  }

  const messages = await client.fetchAll(
    uids,
    {
      uid: true,
      envelope: true,
      flags: true,
      size: true,
      bodyStructure: true,
    },
    { uid: true },
  );
  const summariesByUid = new Map(
    messages.map((message) => {
      const summary = normalizeSummary(message);
      return [summary.uid, summary] as const;
    }),
  );
  return uids.flatMap((uid) => {
    const summary = summariesByUid.get(uid);
    return summary ? [summary] : [];
  });
}

function pageUids(uids: number[], limit: number, beforeUid: number | undefined) {
  const sorted = [...uids].sort((left, right) => right - left);
  const filtered = beforeUid === undefined ? sorted : sorted.filter((uid) => uid < beforeUid);
  const pageProbe = filtered.slice(0, limit + 1);
  const returnedUids = pageProbe.slice(0, limit);
  const lastReturnedUid = returnedUids.at(-1) ?? null;
  return {
    returnedUids,
    nextBeforeUid: pageProbe.length > limit ? lastReturnedUid : null,
  };
}

function normalizeMailbox(value: unknown): MailFolder {
  const record = toRecord(value);
  const delimiter = readString(record?.delimiter);
  const path = readString(record?.path) ?? readString(record?.name) ?? "";
  return {
    path,
    name: readString(record?.name) ?? lastPathSegment(path, delimiter),
    delimiter,
    flags: normalizeStringArray(record?.flags),
    specialUse: readString(record?.specialUse),
  };
}

/**
 * Read the Message-IDs that seed a reply's `References` header.
 *
 * Header fields fold across lines, so continuations are joined before reading
 * them. RFC 5322 uses a single `In-Reply-To` value when `References` is absent.
 */
function readReferences(value: unknown): string[] {
  const raw =
    value instanceof Uint8Array ? new TextDecoder().decode(value) : typeof value === "string" ? value : undefined;
  if (!raw) {
    return [];
  }

  const lines = raw.replaceAll(/\r?\n[ \t]+/g, " ").split(/\r?\n/);
  const referencesLine = lines.find((line) => /^references:/i.test(line));
  if (referencesLine) {
    return referencesLine.slice(referencesLine.indexOf(":") + 1).match(/<[^>]+>/g) ?? [];
  }

  const inReplyToLine = lines.find((line) => /^in-reply-to:/i.test(line));
  const inReplyTo = inReplyToLine?.slice(inReplyToLine.indexOf(":") + 1).match(/<[^>]+>/g) ?? [];
  return inReplyTo.length === 1 ? inReplyTo : [];
}

function normalizeSummary(value: unknown): MailSummary {
  const record = toRecord(value);
  const envelope = toRecord(record?.envelope);
  const uid = readPositiveInteger(record?.uid);
  const flags = normalizeStringArray(record?.flags);
  return {
    uid,
    messageId: readString(envelope?.messageId),
    subject: readString(envelope?.subject),
    from: normalizeEnvelopeAddresses(value, "from")[0] ?? null,
    to: normalizeEnvelopeAddresses(value, "to"),
    date: normalizeDate(envelope?.date ?? record?.internalDate),
    flags,
    seen: flags.includes("\\Seen"),
    hasAttachments: collectAttachmentMetadata(record?.bodyStructure).length > 0,
    size: readInteger(record?.size),
  };
}

function normalizeEnvelopeAddresses(value: unknown, key: "from" | "to" | "cc" | "replyTo"): MailAddress[] {
  const envelope = toRecord(toRecord(value)?.envelope);
  return normalizeAddressList(envelope?.[key]);
}

function normalizeAddressList(value: unknown): MailAddress[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const address = normalizeAddress(item);
    return address.name || address.email ? [address] : [];
  });
}

function normalizeAddress(value: unknown): MailAddress {
  const record = toRecord(value);
  return {
    name: readString(record?.name),
    email: readString(record?.address) ?? readString(record?.email),
  };
}

function collectBodyParts(bodyStructure: unknown): BodyPart[] {
  const record = toRecord(bodyStructure);
  if (!record) {
    return [];
  }

  const childNodes = record.childNodes;
  const childParts = Array.isArray(childNodes) ? childNodes.flatMap(collectBodyParts) : [];
  const type = readString(record.type)?.toLowerCase();
  const part = readString(record.part);
  if (!type || !part || !type.startsWith("text/") || isAttachment(record)) {
    return childParts;
  }

  return [
    ...childParts,
    {
      part,
      type,
      parameters: normalizeStringRecord(record.parameters),
      encoding: readString(record.encoding),
      size: readInteger(record.size),
    },
  ];
}

function collectAttachmentMetadata(bodyStructure: unknown): MailAttachment[] {
  const record = toRecord(bodyStructure);
  if (!record) {
    return [];
  }

  const childNodes = record.childNodes;
  const childAttachments = Array.isArray(childNodes) ? childNodes.flatMap(collectAttachmentMetadata) : [];
  if (!isAttachment(record)) {
    return childAttachments;
  }

  const parameters = normalizeStringRecord(record.parameters);
  const dispositionParameters = normalizeStringRecord(record.dispositionParameters);
  const attachmentId = readString(record.part) ?? readString(record.id);
  if (!attachmentId) {
    return childAttachments;
  }

  return [
    ...childAttachments,
    {
      attachmentId,
      filename: dispositionParameters.filename ?? parameters.name ?? null,
      contentType: readString(record.type),
      size: readInteger(record.size),
      contentId: readString(record.id),
    },
  ];
}

function isAttachment(record: Record<string, unknown>) {
  const disposition = readString(record.disposition)?.toLowerCase();
  const parameters = normalizeStringRecord(record.parameters);
  const dispositionParameters = normalizeStringRecord(record.dispositionParameters);
  return disposition === "attachment" || dispositionParameters.filename !== undefined || parameters.name !== undefined;
}

function selectBodyParts(bodyStructure: MessageStructureObject | undefined, maxBytes: number) {
  const parts = collectBodyParts(bodyStructure);
  let remaining = maxBytes;
  let truncated = false;
  const selected: Array<{ part: BodyPart; maxLength: number; truncatedBeforeFetch: boolean }> = [];

  for (const part of parts) {
    if (remaining <= 0) {
      truncated = true;
      continue;
    }

    const maxLength = Math.min(part.size ?? remaining, remaining);
    remaining -= maxLength;
    selected.push({
      part,
      maxLength,
      truncatedBeforeFetch: part.size !== null && part.size > maxLength,
    });
  }

  if (truncated) {
    return selected.map((item) => ({ ...item, truncatedBeforeFetch: true }));
  }

  return selected;
}

async function parseSelectedBodyParts(
  selectedParts: Array<{ part: BodyPart; maxLength: number; truncatedBeforeFetch: boolean }>,
  bodyFetch: unknown,
): Promise<{ text: string | null; html: string | null; truncated: boolean }> {
  const bodyParts = toRecord(bodyFetch)?.bodyParts;
  const buffers = bodyParts instanceof Map ? bodyParts : new Map<string, Buffer>();
  let text: string | null = null;
  let html: string | null = null;
  let truncated = selectedParts.some((item) => item.truncatedBeforeFetch);

  for (const { part } of selectedParts) {
    const content = buffers.get(part.part);
    if (!content) {
      continue;
    }
    if (part.size !== null && content.length < part.size) {
      truncated = true;
    }

    const parsed = await simpleParser(createBodyPartSource(part, content), {
      skipHtmlToText: true,
      skipTextToHtml: true,
      skipTextLinks: true,
      skipImageLinks: true,
    });
    if (part.type === "text/plain" && parsed.text) {
      text = appendBody(text, parsed.text);
    }
    if (part.type === "text/html" && typeof parsed.html === "string") {
      html = appendBody(html, parsed.html);
    }
  }

  return { text, html, truncated };
}

function createBodyPartSource(part: BodyPart, content: Buffer) {
  const headers = [
    `Content-Type: ${formatContentType(part)}`,
    ...(part.encoding ? [`Content-Transfer-Encoding: ${part.encoding}`] : []),
  ];
  return Buffer.concat([Buffer.from(`${headers.join("\r\n")}\r\n\r\n`), content]);
}

function formatContentType(part: BodyPart) {
  const parameters = Object.entries(part.parameters).map(
    ([key, value]) => `; ${key}="${value.split('"').join('\\"')}"`,
  );
  return `${part.type}${parameters.join("")}`;
}

function appendBody(current: string | null, next: string) {
  return current ? `${current}\n\n${next}` : next;
}

function mapLibraryError(error: unknown, config: MailProtocolConfig): MailProtocolError {
  if (error instanceof MailProtocolError) {
    return error;
  }

  const message = error instanceof Error ? error.message : `${config.displayName} protocol error.`;
  const code = readString(toRecord(error)?.code);
  const lowerMessage = message.toLowerCase();

  if (isAuthError(error, code, lowerMessage)) {
    return new MailProtocolError("auth", message);
  }
  if (isTimeoutError(code, lowerMessage)) {
    return new MailProtocolError("timeout", message);
  }
  if (isNetworkError(code)) {
    return new MailProtocolError("network", message);
  }

  return new MailProtocolError("provider", message);
}

function isAuthError(error: unknown, code: string | null, lowerMessage: string) {
  return (
    toRecord(error)?.authenticationFailed === true ||
    code === "EAUTH" ||
    code === "AUTHENTICATIONFAILED" ||
    lowerMessage.includes("authentication") ||
    lowerMessage.includes("invalid login") ||
    lowerMessage.includes("login failed")
  );
}

function isTimeoutError(code: string | null, lowerMessage: string) {
  return (
    code === "ETIMEDOUT" ||
    // imapflow 的连接/greeting 阶段超时用自有错误码,消息不含 "timeout" 字样
    code === "CONNECT_TIMEOUT" ||
    code === "GREETING_TIMEOUT" ||
    code === "Timeout" ||
    code === "LockTimeout" ||
    lowerMessage.includes("timed out") ||
    lowerMessage.includes("timeout")
  );
}

function isNetworkError(code: string | null) {
  return ["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ESOCKET", "NoConnection"].includes(
    code ?? "",
  );
}

function isFolderMissingError(error: unknown) {
  // imapflow 对命令 NO/BAD 一律 new Error("Command failed"),服务器响应码只落在
  // serverResponseCode、原文落在 response——读 .code/.message 永远匹配不上。
  // 响应码权威:命中即判定;文本匹配仅在响应码缺失时兜底(避免文件夹名本身
  // 含敏感短语时被其他失败原因误命中)。
  const record = toRecord(error);
  const code = (
    readString(record?.serverResponseCode) ?? readString(record?.code) ?? ""
  ).toUpperCase();
  if (code === "NONEXISTENT" || code === "NOTFOUND") return true;
  if (code) return false;
  const text = [
    error instanceof Error ? error.message.toLowerCase() : "",
    readString(record?.response)?.toLowerCase() ?? "",
  ].join(" ");
  return (
    text.includes("[nonexistent]") ||
    text.includes("not found") ||
    text.includes("does not exist") ||
    text.includes("nonexistent")
  );
}

function normalizeStringArray(value: unknown): string[] {
  if (value instanceof Set) {
    return Array.from(value).filter((item): item is string => typeof item === "string");
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  const record = toRecord(value);
  if (!record) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(record).flatMap(([key, item]) => (typeof item === "string" ? [[key, item]] : [])),
  );
}

function normalizeDate(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value !== "string") {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readInteger(value: unknown): number | null {
  return Number.isInteger(value) ? (value as number) : null;
}

function readBigIntString(value: unknown): string | null {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Number.isInteger(value)) {
    return String(value);
  }
  return readString(value);
}

function readPositiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function lastPathSegment(path: string, delimiter: string | null) {
  const parts = delimiter ? path.split(delimiter) : [path];
  return parts.at(-1) ?? path;
}
