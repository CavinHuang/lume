import type { ImPeerKind } from "@lume/shared";

export interface OpenClawWeixinAccountAuth {
  baseUrl: string;
  token: string;
  uin?: string;
}

export interface OpenClawWeixinInboundMessage {
  peerId: string;
  peerKind: ImPeerKind;
  senderId?: string;
  text: string;
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

function extractUnsupportedNotice(update: Record<string, unknown>): string | undefined {
  const itemList = Array.isArray(update.item_list) ? update.item_list : [];
  const items = Array.isArray(update.items) ? update.items : [];
  const types = [...itemList, ...items]
    .map((item) => asRecord(item).type)
    .map((type) => typeof type === "number" || typeof type === "string" ? String(type) : undefined)
    .filter((type): type is string => Boolean(type));
  if (types.length === 0) return undefined;
  return `收到一条暂不支持的微信消息（类型: ${Array.from(new Set(types)).join(", ")}）。当前仅支持文本消息。`;
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
  const text = extractText(update) ?? extractUnsupportedNotice(update);
  if (!peerId || !text) return null;

  return {
    peerId,
    peerKind: update.group_id ? "group" : normalizePeerKind(update.peer_kind ?? update.peerKind ?? update.chat_type),
    senderId,
    text,
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
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: buildHeaders(account),
      body: JSON.stringify(body),
      signal
    });
    const payload = await readPayload(response);
    if (!response.ok) {
      if (isAuthLikePayload(response.status, payload)) {
        throw new OpenClawWeixinAuthError(`OpenClaw Weixin auth required (${response.status})`);
      }
      throw new Error(`OpenClaw Weixin request failed (${response.status})`);
    }
    if (isAuthLikePayload(response.status, payload)) {
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

  return {
    async getUpdates(input = {}) {
      try {
        const payload = await postJson("/ilink/bot/getupdates", {
          get_updates_buf: input.cursor ?? "",
          base_info: baseInfo()
        }, input.signal);
        return {
          cursor: extractCursor(payload),
          updates: extractUpdateList(payload)
            .map(parseInboundMessage)
            .filter((item): item is OpenClawWeixinInboundMessage => item !== null)
        };
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return { updates: [] };
        }
        if (error instanceof Error && error.name === "AbortError") {
          return { updates: [] };
        }
        throw error;
      }
    },

    async sendText(input) {
      return postJson("/ilink/bot/sendmessage", {
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
