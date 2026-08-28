import type { ImPeerKind, ImMessageContent } from "@lume/shared";
import type { WeixinUploadedMedia } from "./openclaw-weixin-media-types";
import { createLogger } from "../../infra/logger";

const log = createLogger("im-api");

export interface OpenClawWeixinAccountAuth {
  baseUrl: string;
  token: string;
  uin?: string;
}

export interface OpenClawWeixinInboundMessage {
  peerId: string;
  peerKind: ImPeerKind;
  senderId?: string;
  /** 发送者显示名（#598，from_user_name；群聊前缀优先于 open_id） */
  senderName?: string;
  text: string;
  contents: ImMessageContent[];
  peerName?: string;
  contextToken?: string;
  messageId?: string;
}

export interface OpenClawWeixinUpdateBatch {
  cursor?: string;
  updates: OpenClawWeixinInboundMessage[];
}

export interface OpenClawWeixinApi {
  getUpdates(input?: { cursor?: string; signal?: AbortSignal }): Promise<OpenClawWeixinUpdateBatch>;
  sendText(input: {
    peerId: string;
    peerKind: ImPeerKind;
    text: string;
    contextToken?: string;
  }): Promise<unknown>;
  notifyStart(): Promise<unknown>;
  notifyStop(): Promise<unknown>;
  sendImage?(input: {
    peerId: string;
    peerKind: ImPeerKind;
    uploaded: WeixinUploadedMedia;
    caption?: string;
    contextToken?: string;
  }): Promise<unknown>;
  sendVideo?(input: {
    peerId: string;
    peerKind: ImPeerKind;
    uploaded: WeixinUploadedMedia;
    caption?: string;
    contextToken?: string;
  }): Promise<unknown>;
  sendFile?(input: {
    peerId: string;
    peerKind: ImPeerKind;
    uploaded: WeixinUploadedMedia;
    fileName: string;
    caption?: string;
    contextToken?: string;
  }): Promise<unknown>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class OpenClawWeixinAuthError extends Error {
  readonly authRequired = true;

  constructor(message: string) {
    super(message);
    this.name = "OpenClawWeixinAuthError";
  }
}

export function isOpenClawWeixinAuthError(error: unknown): boolean {
  return error instanceof OpenClawWeixinAuthError || asRecord(error).authRequired === true;
}

const DEFAULT_CHANNEL_VERSION = "1.0.2";

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

async function readPayload(response: Response): Promise<Record<string, unknown>> {
  try {
    return asRecord(await response.json());
  } catch {
    return {};
  }
}

function isAuthLikePayload(status: number, payload: Record<string, unknown>): boolean {
  const code = asNumber(payload.errcode) ?? asNumber(payload.ret) ?? asNumber(payload.code);
  return status === 401 || status === 403 || code === -14 || code === 401 || code === 403;
}

function normalizePeerKind(value: unknown): ImPeerKind {
  return value === "group" || value === "room" ? "group" : "dm";
}

function extractUpdateList(payload: Record<string, unknown>): unknown[] {
  if (Array.isArray(payload.msgs)) return payload.msgs;
  if (Array.isArray(payload.updates)) return payload.updates;
  if (Array.isArray(payload.update_list)) return payload.update_list;
  const data = asRecord(payload.data);
  if (Array.isArray(data.msgs)) return data.msgs;
  if (Array.isArray(data.updates)) return data.updates;
  if (Array.isArray(data.update_list)) return data.update_list;
  return [];
}

function extractCursor(payload: Record<string, unknown>): string | undefined {
  return asString(payload.get_updates_buf)
    ?? asString(payload.cursor)
    ?? asString(asRecord(payload.data).get_updates_buf)
    ?? asString(asRecord(payload.data).cursor);
}

function extractText(update: Record<string, unknown>): string | undefined {
  const direct = asString(update.text) ?? asString(update.content);
  if (direct) return direct;
  const items = Array.isArray(update.items) ? update.items : [];
  const itemList = Array.isArray(update.item_list) ? update.item_list : [];
  for (const item of itemList) {
    const record = asRecord(item);
    const textItem = asRecord(record.text_item);
    const text = asString(textItem.text) ?? asString(record.text) ?? asString(record.content);
    if (text) return text;
  }
  for (const item of items) {
    const record = asRecord(item);
    const text = asString(record.text) ?? asString(record.text_content) ?? asString(record.content);
    if (text) return text;
  }
  return undefined;
}

function extractTextContent(record: Record<string, unknown>): ImMessageContent {
  const textItem = asRecord(record.text_item);
  const text = asString(textItem.text) ?? asString(record.text) ?? asString(record.content) ?? "";
  return { type: "text", text };
}

function extractImageContent(record: Record<string, unknown>): ImMessageContent {
  const item = asRecord(record.image_item);
  const media = asRecord(item.media);
  return {
    type: "image",
    // 优先 full_url（可直接下载）；其次 encrypt_query_param（由 resolver 拼 CDN URL）；最后兜底 url 字段
    url: asString(media.full_url) ?? asString(media.encrypt_query_param) ?? asString(item.url) ?? "",
    thumbnailUrl: asString(asRecord(item.thumb_media).full_url),
    width: asNumber(item.thumb_width),
    height: asNumber(item.thumb_height),
    aesKey: asString(media.aes_key),
  };
}

function extractVoiceContent(record: Record<string, unknown>): ImMessageContent {
  const item = asRecord(record.voice_item);
  return {
    type: "voice",
    text: asString(item.text),
    playtime: asNumber(item.playtime),
  };
}

function extractFileContent(record: Record<string, unknown>): ImMessageContent {
  const item = asRecord(record.file_item);
  const media = asRecord(item.media);
  const len = typeof item.len === "string" ? Number(item.len) : (asNumber(item.len) ?? 0);
  return {
    type: "file",
    fileName: asString(item.file_name) ?? "unknown",
    fileSize: Number.isFinite(len) ? len : 0,
    md5: asString(item.md5),
    // 优先 full_url（可直接下载）；否则用 encrypt_query_param（由 resolver 拼 CDN URL）
    downloadUrl: asString(media.full_url) ?? asString(media.encrypt_query_param),
    aesKey: asString(media.aes_key),
  };
}

function extractVideoContent(record: Record<string, unknown>): ImMessageContent {
  const item = asRecord(record.video_item);
  return {
    type: "video",
    thumbnailUrl: asString(asRecord(item.thumb_media).full_url),
    playLength: asNumber(item.play_length),
    fileSize: asNumber(item.video_size),
  };
}

function extractContents(update: Record<string, unknown>): ImMessageContent[] {
  const items = [
    ...(Array.isArray(update.item_list) ? update.item_list : []),
    ...(Array.isArray(update.items) ? update.items : []),
  ];

  if (items.length === 0) {
    const directText = extractText(update);
    return directText ? [{ type: "text", text: directText }] : [];
  }

  return items.map(item => {
    const record = asRecord(item);
    switch (record.type) {
      case 1: return extractTextContent(record);
      case 2: return extractImageContent(record);
      case 3: return extractVoiceContent(record);
      case 4: return extractFileContent(record);
      case 5: return extractVideoContent(record);
      default: return { type: "text" as const, text: `[不支持的消息类型: ${record.type}]` };
    }
  });
}

function textSummaryForContents(contents: ImMessageContent[]): string {
  if (contents.length === 0) return "";
  if (contents.length === 1 && contents[0]?.type === "text") return contents[0].text;
  return contents.map(c => {
    switch (c.type) {
      case "text": return c.text;
      case "image": return "[图片]";
      case "voice": return c.text ? `[语音: ${c.text}]` : "[语音]";
      case "file": return `[文件: ${c.fileName}]`;
      case "video": return "[视频]";
    }
  }).join(" ");
}

function parseInboundMessage(raw: unknown): OpenClawWeixinInboundMessage | null {
  const update = asRecord(raw);
  const senderId =
    asString(update.from_user_id)
    ?? asString(update.from_user_name)
    ?? asString(update.fromUserName);
  const peerId =
    asString(update.group_id)
    ?? asString(update.peer_id)
    ?? asString(update.peerId)
    ?? senderId
    ?? asString(update.user_name)
    ?? asString(update.to_user_name);
  if (!peerId) return null;

  const contents = extractContents(update);
  if (contents.length === 0) return null;
  const text = textSummaryForContents(contents);

  return {
    peerId,
    peerKind: update.group_id ? "group" : normalizePeerKind(update.peer_kind ?? update.peerKind ?? update.chat_type),
    senderId,
    senderName: asString(update.from_user_name) ?? asString(update.fromUserName),
    text,
    contents,
    peerName: asString(update.peer_name) ?? asString(update.peerName) ?? asString(update.nickname),
    contextToken: asString(update.context_token) ?? asString(update.contextToken),
    messageId: asString(update.message_id) ?? asString(update.messageId) ?? (
      typeof update.message_id === "number" ? String(update.message_id) : undefined
    )
  };
}

function buildHeaders(account: OpenClawWeixinAccountAuth): Record<string, string> {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${account.token}`
  };
}

export function createOpenClawWeixinApi(
  account: OpenClawWeixinAccountAuth,
  fetchImpl: FetchLike = fetch
): OpenClawWeixinApi {
  const baseUrl = normalizeBaseUrl(account.baseUrl);

  async function postJson(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const msg = asRecord(body.msg);
    log.debug("发送请求", { path, toUserId: asString(msg.to_user_id ?? body.to_user_id) });
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: buildHeaders(account),
        body: JSON.stringify(body),
        signal
      });
    } catch (error) {
      log.error("请求网络错误", { path, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    const payload = await readPayload(response);
    if (!response.ok) {
      if (isAuthLikePayload(response.status, payload)) {
        log.warn("认证失败", { path, status: response.status });
        throw new OpenClawWeixinAuthError(`OpenClaw Weixin auth required (${response.status})`);
      }
      log.error("请求失败", { path, status: response.status, errcode: payload.errcode ?? payload.ret ?? payload.code });
      throw new Error(`OpenClaw Weixin request failed (${response.status})`);
    }
    if (isAuthLikePayload(response.status, payload)) {
      log.warn("响应指示认证问题", { path, status: response.status });
      throw new OpenClawWeixinAuthError(
        asString(payload.errmsg) ?? asString(payload.message) ?? "OpenClaw Weixin auth required"
      );
    }
    return payload;
  }

  function baseInfo(): Record<string, unknown> {
    return {
      channel_version: DEFAULT_CHANNEL_VERSION
    };
  }

  function buildCdnMediaRef(uploaded: WeixinUploadedMedia): Record<string, unknown> {
    return {
      encrypt_query_param: uploaded.downloadEncryptedQueryParam,
      // 对齐 Tencent openclaw-weixin 协议：aes_key 是 hex 字符串本身的 base64（默认 utf8 编码），
      // 不是解码后的 16 字节真实 key。误用 Buffer.from(aeskey, "hex") 会导致微信解密失败（灰底图）。
      aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
      encrypt_type: 1,
    };
  }

  async function sendMediaItems(params: {
    peerId: string;
    mediaItem: Record<string, unknown>;
    caption?: string;
    contextToken?: string;
  }): Promise<unknown> {
    const items: Record<string, unknown>[] = [];
    if (params.caption) {
      items.push({ type: 1, text_item: { text: params.caption } });
    }
    items.push(params.mediaItem);

    log.info("发送媒体消息", { peerId: params.peerId, mediaType: params.mediaItem.type, itemCount: items.length, hasCaption: !!params.caption });

    let lastResult: unknown;
    for (const item of items) {
      lastResult = await postJson("/ilink/bot/sendmessage", {
        msg: {
          from_user_id: "",
          to_user_id: params.peerId,
          client_id: `lume-im-weixin-${crypto.randomUUID()}`,
          message_type: 2,
          message_state: 2,
          context_token: params.contextToken ?? undefined,
          item_list: [item],
        },
        base_info: baseInfo(),
      });
    }
    log.info("媒体消息发送成功", { peerId: params.peerId, mediaType: params.mediaItem.type });
    return lastResult;
  }

  return {
    async getUpdates(input = {}) {
      try {
        const payload = await postJson("/ilink/bot/getupdates", {
          get_updates_buf: input.cursor ?? "",
          base_info: baseInfo()
        }, input.signal);
        const updates = extractUpdateList(payload)
          .map(parseInboundMessage)
          .filter((item): item is OpenClawWeixinInboundMessage => item !== null);
        if (updates.length > 0) {
          log.debug("收到新消息", { count: updates.length, peers: updates.map(u => u.peerId) });
        }
        return {
          cursor: extractCursor(payload),
          updates,
        };
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return { updates: [] };
        }
        if (error instanceof Error && error.name === "AbortError") {
          return { updates: [] };
        }
        log.error("轮询消息失败", { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },

    async sendText(input) {
      log.info("发送文本消息", { peerId: input.peerId, peerKind: input.peerKind, textLength: input.text.length });
      try {
        const result = await postJson("/ilink/bot/sendmessage", {
          msg: {
            from_user_id: "",
            to_user_id: input.peerId,
            client_id: `lume-im-weixin-${crypto.randomUUID()}`,
            message_type: 2,
            message_state: 2,
            ...(input.contextToken ? { context_token: input.contextToken } : {}),
            item_list: [{
              type: 1,
              text_item: {
                text: input.text
              }
            }]
          },
          base_info: baseInfo()
        });
        log.info("文本消息发送成功", { peerId: input.peerId });
        return result;
      } catch (error) {
        log.error("文本消息发送失败", { peerId: input.peerId, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },

    async sendImage(input) {
      return sendMediaItems({
        peerId: input.peerId,
        caption: input.caption,
        contextToken: input.contextToken,
        mediaItem: {
          type: 2,
          image_item: {
            media: buildCdnMediaRef(input.uploaded),
            mid_size: input.uploaded.fileSizeCiphertext,
          },
        },
      });
    },

    async sendVideo(input) {
      return sendMediaItems({
        peerId: input.peerId,
        caption: input.caption,
        contextToken: input.contextToken,
        mediaItem: {
          type: 5,
          video_item: {
            media: buildCdnMediaRef(input.uploaded),
            video_size: input.uploaded.fileSizeCiphertext,
          },
        },
      });
    },

    async sendFile(input) {
      return sendMediaItems({
        peerId: input.peerId,
        caption: input.caption,
        contextToken: input.contextToken,
        mediaItem: {
          type: 4,
          file_item: {
            media: buildCdnMediaRef(input.uploaded),
            file_name: input.fileName,
            len: String(input.uploaded.fileSize),
          },
        },
      });
    },

    async notifyStart() {
      return postJson("/ilink/bot/msg/notifystart", {
        base_info: baseInfo()
      });
    },

    async notifyStop() {
      return postJson("/ilink/bot/msg/notifystop", {
        base_info: baseInfo()
      });
    }
  };
}
