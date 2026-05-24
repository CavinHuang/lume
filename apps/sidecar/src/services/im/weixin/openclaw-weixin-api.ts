import type { ImPeerKind } from "@lume/shared";

export interface OpenClawWeixinAccountAuth {
  baseUrl: string;
  token: string;
  uin?: string;
}

export interface OpenClawWeixinInboundMessage {
  peerId: string;
  peerKind: ImPeerKind;
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
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_CHANNEL_VERSION = "lume-im-weixin/0.1";
const DEFAULT_BOT_AGENT = "lume";
const DEFAULT_ILINK_APP_ID = "lume";

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

function normalizePeerKind(value: unknown): ImPeerKind {
  return value === "group" || value === "room" ? "group" : "dm";
}

function extractUpdateList(payload: Record<string, unknown>): unknown[] {
  if (Array.isArray(payload.updates)) return payload.updates;
  if (Array.isArray(payload.update_list)) return payload.update_list;
  const data = asRecord(payload.data);
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
  for (const item of items) {
    const record = asRecord(item);
    const text = asString(record.text) ?? asString(record.text_content) ?? asString(record.content);
    if (text) return text;
  }
  return undefined;
}

function parseInboundMessage(raw: unknown): OpenClawWeixinInboundMessage | null {
  const update = asRecord(raw);
  const peerId =
    asString(update.peer_id)
    ?? asString(update.peerId)
    ?? asString(update.from_user_name)
    ?? asString(update.fromUserName)
    ?? asString(update.user_name)
    ?? asString(update.to_user_name);
  const text = extractText(update);
  if (!peerId || !text) return null;

  return {
    peerId,
    peerKind: normalizePeerKind(update.peer_kind ?? update.peerKind ?? update.chat_type),
    text,
    peerName: asString(update.peer_name) ?? asString(update.peerName) ?? asString(update.nickname),
    contextToken: asString(update.context_token) ?? asString(update.contextToken),
    messageId: asString(update.message_id) ?? asString(update.messageId)
  };
}

function buildHeaders(account: OpenClawWeixinAccountAuth): Record<string, string> {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${account.token}`,
    ...(account.uin ? { "X-WECHAT-UIN": account.uin } : {}),
    "iLink-App-Id": DEFAULT_ILINK_APP_ID,
    "iLink-App-ClientVersion": DEFAULT_CHANNEL_VERSION
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
    if (!response.ok) {
      throw new Error(`OpenClaw Weixin request failed (${response.status})`);
    }
    return asRecord(await response.json());
  }

  function baseInfo(): Record<string, unknown> {
    return {
      ...(account.uin ? { uin: account.uin } : {}),
      channel_version: DEFAULT_CHANNEL_VERSION,
      bot_agent: DEFAULT_BOT_AGENT
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
        base_info: baseInfo(),
        to_user_name: input.peerId,
        peer_kind: input.peerKind,
        message_type: 2,
        message_state: 2,
        ...(input.contextToken ? { context_token: input.contextToken } : {}),
        items: [{
          type: 1,
          text: input.text
        }]
      });
    }
  };
}
