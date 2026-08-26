import * as lark from "@larksuiteoapi/node-sdk";
import { createLogger } from "../../infra/logger";
import { splitImMessage } from "../outbound-segment";

const log = createLogger("im-feishu-api");

/** 仅描述出站/入站增强用到的调用面(message/chat/bot/cardkit),便于测试注入伪实现。 */
export interface FeishuRestClient {
  im: {
    v1: {
      message: {
        create(req: {
          params: { receive_id_type: string };
          data: { receive_id: string; msg_type: string; content: string };
        }): Promise<unknown>;
        get(req: { params: { message_id: string } }): Promise<{
          code?: number;
          data?: { items?: Array<{ msg_type?: string; sender?: { id?: string }; body?: { content?: string } }> };
        }>;
      };
      chat: {
        get(req: { params: { chat_id: string } }): Promise<{
          code?: number;
          data?: { user_count?: number; name?: string };
        }>;
      };
    };
  };
  bot: {
    v3: {
      botInfo: {
        get(): Promise<{ code?: number; bot?: { open_id?: string; activate_status?: number } }>;
      };
    };
  };
  cardkit: {
    v1: {
      card: {
        // 形状对齐 @larksuiteoapi/node-sdk：create 传完整卡片 JSON 字符串，
        // update 为 path.card_id + data.sequence + 全量 card 实体
        create(req: { data: { type: string; data: string } }): Promise<{ code?: number; data?: { card_id?: string } }>;
        update(req: {
          data: { sequence: number; card: { type: "card_json"; data: string } };
          path: { card_id: string };
        }): Promise<{ code?: number }>;
      };
    };
  };
}

export interface SendFeishuTextInput {
  appId: string;
  appSecret: string;
  /** 目标会话 chat_id(单聊/群聊);来自入站 event.message.chat_id,经 thread binding 传回。 */
  peerId: string;
  text: string;
}

export interface FeishuApiDeps {
  /** 测试注入伪 client;生产省略走按 appId 缓存的 lark.Client 工厂。 */
  createClient?: (appId: string, appSecret: string) => FeishuRestClient;
}

// 按 appId 缓存 lark.Client,复用其内部 tenant_access_token 自动刷新,避免每次发送都重取 token。
const clientCache = new Map<string, FeishuRestClient>();

function defaultCreateClient(appId: string, appSecret: string): FeishuRestClient {
  return new lark.Client({ appId, appSecret }) as unknown as FeishuRestClient;
}

const SEND_TIMEOUT_MS = 15_000;

/** #596:lark Client 无超时参数(仅 httpInstance 可注入),SDK 默认可达分钟级——
 * 在调用层包显式超时,失败尽快暴露给出站链路。注意这是"放弃等待"而非真取消,
 * 底层 HTTP 请求仍会跑完。 */
async function withSendTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`飞书请求超时(${SEND_TIMEOUT_MS / 1000}s)`)), SEND_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

function getFeishuClient(appId: string, appSecret: string): FeishuRestClient {
  // 缓存键含 secret：用户轮换 App Secret 后旧 client 的 tenant_access_token
  // 获取会持续失败直至进程重启（#405）
  const cacheKey = `${appId}|${appSecret}`;
  let client = clientCache.get(cacheKey);
  if (!client) {
    client = defaultCreateClient(appId, appSecret);
    clientCache.set(cacheKey, client);
    if (clientCache.size > 16) {
      const oldest = clientCache.keys().next().value;
      if (oldest !== undefined) clientCache.delete(oldest);
    }
  }
  return client;
}

/** 供卡片流等出站组件复用按 appId 缓存的共享 client。 */
export function getSharedFeishuClient(appId: string, appSecret: string): FeishuRestClient {
  return getFeishuClient(appId, appSecret);
}

/**
 * 飞书出站:client.im.v1.message.create 发送文本到指定 chat_id。
 * content 为 JSON 字符串 {"text":"..."}。与入站 WSClient 分离(REST)。
 */
export async function sendFeishuText(
  input: SendFeishuTextInput,
  deps: FeishuApiDeps = {},
): Promise<{ ok: boolean; error?: string }> {
  if (!input.appId || !input.appSecret) {
    return { ok: false, error: "缺少 App ID/App Secret,无法发送飞书消息" };
  }
  const getClient = deps.createClient ?? getFeishuClient;
  try {
    const client = getClient(input.appId, input.appSecret);
    for (const segment of splitImMessage(input.text, { maxChars: 4000 })) {
      await withSendTimeout(client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: input.peerId,
          msg_type: "text",
          content: JSON.stringify({ text: segment }),
        },
      }));
    }
    return { ok: true };
  } catch (error) {
    log.error("飞书 sendText 失败", { error: error instanceof Error ? error.message : String(error) });
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// 入站增强读取面：机器人身份 / 群信息 / 引用消息（均为尽力而为，失败返回 null）
// ---------------------------------------------------------------------------

const botOpenIdCache = new Map<string, string>();

/**
 * 机器人自身 open_id（#405 群聊精确 @ 匹配的前提）。按 appId+secret 缓存
 * （身份不变更），失败返回 null 由调用方降级到启发式。
 */
export async function getFeishuBotOpenId(
  input: { appId: string; appSecret: string },
  deps: FeishuApiDeps = {}
): Promise<string | null> {
  if (!input.appId || !input.appSecret) return null;
  const cacheKey = `${input.appId} ${input.appSecret}`;
  const cached = botOpenIdCache.get(cacheKey);
  if (cached) return cached;
  try {
    const getClient = deps.createClient ?? getFeishuClient;
    const client = getClient(input.appId, input.appSecret);
    const result = await client.bot.v3.botInfo.get();
    if (result.code && result.code !== 0) {
      log.warn("获取机器人身份被拒", { code: result.code });
      return null;
    }
    const openId = result.bot?.open_id;
    if (!openId) return null;
    botOpenIdCache.set(cacheKey, openId);
    return openId;
  } catch (error) {
    log.warn("获取机器人身份失败", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** 重置机器人身份缓存（App Secret 轮换场景/测试）。 */
export function resetFeishuBotOpenIdCacheForTest(): void {
  botOpenIdCache.clear();
}

const chatInfoCache = new Map<string, { userCount: number; expiresAtMs: number }>();
const CHAT_INFO_TTL_MS = 5 * 60 * 1000;

/**
 * 群成员数（单人群免 @ 判定的权威依据）。短 TTL 缓存平衡准确性与 API 配额；
 * 失败返回 null（策略层据此跳过单人群豁免）。
 */
export async function getFeishuChatUserCount(
  input: { appId: string; appSecret: string; chatId: string },
  deps: FeishuApiDeps = {}
): Promise<number | null> {
  const cacheKey = `${input.appId}:${input.chatId}`;
  const cached = chatInfoCache.get(cacheKey);
  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.userCount;
  }
  try {
    const getClient = deps.createClient ?? getFeishuClient;
    const client = getClient(input.appId, input.appSecret);
    const result = await client.im.v1.chat.get({ params: { chat_id: input.chatId } });
    if (result.code && result.code !== 0) return null;
    const userCount = result.data?.user_count;
    if (typeof userCount !== "number") return null;
    chatInfoCache.set(cacheKey, { userCount, expiresAtMs: Date.now() + CHAT_INFO_TTL_MS });
    return userCount;
  } catch (error) {
    log.warn("获取群信息失败", { chatId: input.chatId, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

export interface FeishuQuotedMessage {
  senderId?: string;
  /** 文本类消息的可读文本；post 富文本拼接纯文本；其他类型给类型占位说明 */
  text: string;
}

/** 解析 im.v1.message.get 的 content JSON 为可读文本（仅用于引用上下文注入）。 */
function parseFeishuMessageContent(msgType: string | undefined, contentJson: string | undefined): string {
  if (!contentJson) return "";
  try {
    const parsed = JSON.parse(contentJson) as Record<string, unknown>;
    switch (msgType) {
      case "text":
        return typeof parsed.text === "string" ? parsed.text : "";
      case "post": {
        // post 富文本: { title?, content: Array<Array<{ tag, text?, href? }>> }
        const title = typeof parsed.title === "string" ? parsed.title : "";
        const paragraphs = Array.isArray(parsed.content) ? parsed.content : [];
        const lines: string[] = [];
        for (const paragraph of paragraphs as Array<Array<Record<string, unknown>>>) {
          if (!Array.isArray(paragraph)) continue;
          const line = paragraph
            .map((node) => (typeof node?.text === "string" ? node.text : ""))
            .join("");
          if (line) lines.push(line);
        }
        return [title, ...lines].filter(Boolean).join("\n");
      }
      case "interactive":
        return "[卡片消息]";
      case "image":
        return "[图片]";
      case "file":
        return "[文件]";
      case "audio":
        return "[语音]";
      case "media":
        return "[视频]";
      default:
        return `[${msgType ?? "未知类型"}]`;
    }
  } catch {
    return "";
  }
}

/** 拉取一条消息作为引用上下文（长按回复场景）；不可得时返回 null。 */
export async function getFeishuQuotedMessage(
  input: { appId: string; appSecret: string; messageId: string },
  deps: FeishuApiDeps = {}
): Promise<FeishuQuotedMessage | null> {
  try {
    const getClient = deps.createClient ?? getFeishuClient;
    const client = getClient(input.appId, input.appSecret);
    const result = await client.im.v1.message.get({ params: { message_id: input.messageId } });
    if (result.code && result.code !== 0) return null;
    const item = result.data?.items?.[0];
    if (!item) return null;
    const readable = parseFeishuMessageContent(item.msg_type, item.body?.content);
    if (!readable) return null;
    return {
      ...(item.sender?.id ? { senderId: item.sender.id } : {}),
      text: readable
    };
  } catch (error) {
    log.warn("获取引用消息失败", { messageId: input.messageId, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
