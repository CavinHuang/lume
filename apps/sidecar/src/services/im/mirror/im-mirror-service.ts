import type { LumeRuntimeEvent, ImMirrorStreamActivity, ImMirrorEntryPublic } from "@lume/shared";
import {
  getImMirrorSettings,
  getImMirrorEntryByThreadId,
  upsertImMirrorEntry,
  removeImMirrorEntriesByThreadId,
  noteMirrorConfigError
} from "../im-mirror-store";
import { getImThreadBindingByThreadId } from "../im-thread-binding-store";
import { getImRuntimeAccount, listImAccounts, type ImRuntimeAccount } from "../im-config-manager";
import { getImProvider } from "../provider-registry";
import { buildImRunCardSession, type ImRunCardSession, type ImRunCardFinishStatus } from "../im-run-card-session";
import { createMirrorTranscriptCarrier } from "./mirror-transcript-carrier";
import { describeImMirrorFailure } from "./describe-mirror-failure";
import { getAgentThreadMeta } from "../../agent/agent-thread-manager";
import { createLogger } from "../../infra/logger";

const log = createLogger("im-mirror-service");

/**
 * #544 会话镜像编排服务。
 *
 * 自环两道结构性守卫（任一命中直接不镜像）：
 * 1. 「线程存在 DM 绑定 ⇒ IM 来源」——镜像映射绝不写入绑定表，判定永不被污染；
 * 2. 提交 origin 以 im. 开头的 run（含反向续聊回流）不再触发镜像。
 * off 模式 / 无承担账号 / 非活跃线程等一切不满足情形都返回原 emitter 引用，
 * 桌面行为零变化；建群等写操作失败静默降级并落账号级错误文案供设置页明示。
 */

/** 首个内容类事件才真正开始镜像（与卡片开卡同口径），元数据级运行零副作用 */
const MIRROR_START_TRIGGER_EVENTS = new Set([
  "assistant.delta",
  "assistant.thinking_delta",
  "assistant.final",
  "tool.started"
]);

const MAX_PENDING_EVENTS = 400;

function sanitizeGroupName(title: string): string {
  const trimmed = title.trim();
  return trimmed ? trimmed.slice(0, 40) : "Lume 会话镜像";
}

export function isMirrorCandidate(threadId: string): boolean {
  // 守卫一：DM 绑定存在即 IM 来源线程（绑定表未被镜像污染，判定可靠）
  if (getImThreadBindingByThreadId(threadId)) return false;
  const meta = getAgentThreadMeta(threadId);
  if (!meta) return false;
  // status 缺省视为活跃（与路由器陈旧守卫口径一致）
  if (meta.status === "archived" || meta.status === "trashed") return false;
  // 映射权威：已有映射（attach 附着档）直接候选，不受全局开关影响；
  // 否则需全局承担者（飞书自动建群路径）
  if (getImMirrorEntryByThreadId(threadId)) return true;
  return Boolean(getImMirrorSettings().enabledMirrorAccountId);
}

/** 群内出站文本（兜底正文/文本档载体统一出口），provider 内部自带分段与错误日志 */
async function postToMirror(account: ImRuntimeAccount, chatId: string, text: string): Promise<void> {
  await getImProvider(account.provider).sendText({
    account,
    peerId: chatId,
    peerKind: "group",
    text
  });
}

/**
 * 自动建群路径：用「最近 DM 互动发送者」为目标用户建群（仅全局承担者账号）。
 * 失败静默降级并写账号级错误文案（设置页红字槽展示），下次运行天然重试。
 * 仅在无映射时调用——attach 附着档的映射由 RPC 显式写入，不走此处。
 */
async function ensureCreateMirrorChat(
  threadId: string,
  owner: string,
  fallbackTitle: string
): Promise<ImMirrorEntryPublic | null> {
  const fail = (message: string): null => {
    noteMirrorConfigError(owner, message);
    return null;
  };

  const publicAccount = listImAccounts().find((item) => item.id === owner);
  if (!publicAccount) return fail("承担镜像的 IM 账号已不存在，请重新选择");
  if (!publicAccount.enabled) return fail("承担镜像的账号未启用");

  let definition;
  try {
    definition = getImProvider(publicAccount.provider);
  } catch (error) {
    return fail(`渠道未注册：${error instanceof Error ? error.message : String(error)}`);
  }
  const capabilities = definition.mirror;
  if (!capabilities?.createGroup) {
    return fail("当前渠道暂不支持自动建群，请选择支持的账号或改用附着模式");
  }

  const targetUserId = publicAccount.lastInteractedSenderId?.trim();
  if (!targetUserId) {
    return fail("还没有可拉入镜像群的用户——请先在 IM 里与该账号私聊一次");
  }

  const account = getImRuntimeAccount(owner);
  const created = await capabilities.createGroup({
    account,
    name: sanitizeGroupName(fallbackTitle),
    userOpenId: targetUserId
  });
  if (!created.ok || !created.chatId) {
    return fail(describeImMirrorFailure(created.error));
  }

  const nextEntry = upsertImMirrorEntry({
    threadId,
    accountId: owner,
    chatId: created.chatId,
    carrier: capabilities.carrier
  });
  noteMirrorConfigError(owner, null);
  log.info("镜像群已创建", { threadId: threadId.slice(0, 8), chatId: created.chatId });
  return nextEntry;
}

async function startMirrorCarry(threadId: string): Promise<ImRunCardSession | null> {
  // 映射权威：attach 附着档的映射是显式用户意图，账号/渠道/载体均以映射为准；
  // 无映射时才回退到全局承担者的自动建群路径（飞书）。
  let entry = getImMirrorEntryByThreadId(threadId);
  if (!entry) {
    const owner = getImMirrorSettings().enabledMirrorAccountId;
    if (!owner) return null;
    const title = getAgentThreadMeta(threadId)?.title ?? "";
    entry = await ensureCreateMirrorChat(threadId, owner, title);
    if (!entry) return null;
  }

  let account: ImRuntimeAccount;
  try {
    account = getImRuntimeAccount(entry.accountId);
  } catch (error) {
    noteMirrorConfigError(
      entry.accountId,
      describeImMirrorFailure(error instanceof Error ? error.message : String(error))
    );
    return null;
  }

  let definition;
  try {
    definition = getImProvider(account.provider);
  } catch (error) {
    noteMirrorConfigError(
      entry.accountId,
      `渠道未注册：${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
  const capabilities = definition.mirror;
  if (!capabilities) {
    noteMirrorConfigError(entry.accountId, "当前渠道暂不支持镜像");
    return null;
  }

  if (capabilities.carrier === "card") {
    return buildImRunCardSession({
      threadId,
      appId: account.accountKey ?? "",
      appSecret: account.token ?? "",
      chatId: entry.chatId,
      onTerminalFlushFailed: (finalText) => {
        if (!finalText) return;
        void postToMirror(account, entry!.chatId, finalText).catch(() => {});
      }
    });
  }
  return createMirrorTranscriptCarrier({
    threadTitle: getAgentThreadMeta(threadId)?.title ?? "",
    send: (text) => postToMirror(account, entry!.chatId, text)
  });
}

// ---------------------------------------------------------------------------
// 保活通知：stream 卡片活跃窗口经 sidecar 层订阅转 writeNotification 推桌面 main
// ---------------------------------------------------------------------------

type MirrorStreamListener = (activity: ImMirrorStreamActivity) => void;
const streamActivityListeners = new Set<MirrorStreamListener>();

export function subscribeImMirrorStreamActivity(listener: MirrorStreamListener): () => void {
  streamActivityListeners.add(listener);
  return () => {
    streamActivityListeners.delete(listener);
  };
}

function notifyStreamActivity(threadId: string, active: boolean): void {
  for (const listener of streamActivityListeners) {
    try {
      listener({ threadId, active });
    } catch (error) {
      log.warn("保活通知监听器失败", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

// ---------------------------------------------------------------------------
// emitter 包装：所有 run 入口的单行挂载点
// ---------------------------------------------------------------------------

type MirrorCompletePayload = { reason?: "max_turns" | "repeat_guard" | "stopped" };
type MirrorErrorOptions = { fromActiveRun?: boolean };

interface MirrorEmitterHost {
  onRuntimeEvent?: (event: LumeRuntimeEvent) => void;
  onComplete: (payload?: MirrorCompletePayload) => void;
  onError: (error: string, options?: MirrorErrorOptions) => void;
}

function completeStatusOf(payload?: MirrorCompletePayload): ImRunCardFinishStatus {
  switch (payload?.reason) {
    case "max_turns":
      return { kind: "turn_limited" };
    case "stopped":
    case "repeat_guard":
      return { kind: "interrupted" };
    default:
      return { kind: "completed" };
  }
}

/**
 * 包装桌面侧 emitter 使其同步驱动镜像会话。不满足镜像条件时原引用直返，
 * 保证 off 模式严格零行为变化（测试断言引用相等）。
 */
export function wrapAgentEmitterForMirror<T extends object>(threadId: string, emit: T, origin?: string): T {
  // 守卫二：im.* 来源的提交（含镜像群反向续聊）永不再次镜像
  if (typeof origin === "string" && origin.startsWith("im.")) return emit;
  if (!isMirrorCandidate(threadId)) return emit;

  let starting = false;
  let aborted = false;
  let ended = false;
  let activated = false;
  let carry: ImRunCardSession | null = null;
  let pendingEvents: LumeRuntimeEvent[] = [];

  const begin = (): void => {
    if (starting) return;
    starting = true;
    void startMirrorCarry(threadId)
      .then((next) => {
        if (ended) return;
        carry = next;
        if (!carry) {
          // 建群失败等静默场景：丢弃缓冲、此后事件直通不做缓冲
          aborted = true;
          pendingEvents = [];
          return;
        }
        for (const event of pendingEvents.splice(0)) {
          carry.handleEvent(event);
        }
        void carry
          .settleOpen()
          .then((ok) => {
            if (ok && !ended) {
              activated = true;
              notifyStreamActivity(threadId, true);
            }
          })
          .catch(() => {});
      })
      .catch((error) => {
        // 兜底不允许外抛，但失败必须留痕（镜像属增强路径，不影响桌面主链路）
        aborted = true;
        log.warn("镜像会话启动失败", { threadId: threadId.slice(0, 8), error: error instanceof Error ? error.message : String(error) });
      });
  };

  const finishOnce = (status: ImRunCardFinishStatus): void => {
    if (ended) return;
    ended = true;
    carry?.finish(status);
    if (activated) notifyStreamActivity(threadId, false);
  };

  const host = emit as unknown as MirrorEmitterHost;
  return {
    ...(emit as Record<string, unknown>),
    onRuntimeEvent: (event: LumeRuntimeEvent) => {
      host.onRuntimeEvent?.(event);
      if (ended) return;
      if (!starting && MIRROR_START_TRIGGER_EVENTS.has(event.type)) {
        begin();
      }
      if (carry) {
        carry.handleEvent(event);
      } else if (starting && !aborted && pendingEvents.length < MAX_PENDING_EVENTS) {
        pendingEvents.push(event);
      }
    },
    onComplete: (payload?: MirrorCompletePayload) => {
      host.onComplete(payload);
      finishOnce(completeStatusOf(payload));
    },
    onError: (error: string, options?: MirrorErrorOptions) => {
      host.onError(error, options);
      finishOnce({ kind: "failed", error });
    }
  } as T;
}

// ---------------------------------------------------------------------------
// 群生命周期联动（标题钩子 / 线程删除退群）
// ---------------------------------------------------------------------------

const lastSyncedTitles = new Map<string, string>();

/** 标题变化时同步群名；无 renameGroup 能力的渠道静默跳过。fire-and-forget。 */
export async function syncMirrorGroupNameFromMeta(threadId: string, title: string): Promise<void> {
  try {
    const entry = getImMirrorEntryByThreadId(threadId);
    if (!entry) return;
    const nextTitle = title.trim();
    if (!nextTitle || lastSyncedTitles.get(threadId) === nextTitle) return;
    lastSyncedTitles.set(threadId, nextTitle);

    const definition = getImProvider(getImRuntimeAccount(entry.accountId).provider);
    const renameGroup = definition.mirror?.renameGroup;
    if (!renameGroup) return;
    const result = await renameGroup({
      account: getImRuntimeAccount(entry.accountId),
      chatId: entry.chatId,
      name: sanitizeGroupName(nextTitle)
    });
    if (!result.ok) {
      log.info("镜像群名同步失败", { threadId: threadId.slice(0, 8), error: result.error });
    }
  } catch (error) {
    log.info("镜像群名同步跳过", { error: error instanceof Error ? error.message : String(error) });
  }
}

/** 线程删除：机器人退群（固定不解散）+ 清映射，全程静默。 */
export async function dissolveMirrorForThread(threadId: string): Promise<void> {
  try {
    const entry = getImMirrorEntryByThreadId(threadId);
    lastSyncedTitles.delete(threadId);
    removeImMirrorEntriesByThreadId(threadId);
    if (!entry) return;
    const definition = getImProvider(getImRuntimeAccount(entry.accountId).provider);
    if (!definition.mirror?.leaveGroup) return;
    await definition.mirror.leaveGroup({
      account: getImRuntimeAccount(entry.accountId),
      chatId: entry.chatId
    });
    log.info("镜像退群完成", { threadId: threadId.slice(0, 8), chatId: entry.chatId });
  } catch (error) {
    log.info("镜像退群静默失败", { error: error instanceof Error ? error.message : String(error) });
  }
}
