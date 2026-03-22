/**
 * 飞书消息解析工具 — 供 Webhook 和 WebSocket 两种 ingress 共用
 */

export type FeishuMessageEventPayload = {
  schema?: string;
  header?: {
    event_id?: string;
    event_type?: string;
    create_time?: string;
  };
  event?: {
    sender?: {
      sender_id?: {
        open_id?: string;
        user_id?: string;
        union_id?: string;
      };
    };
    message?: {
      message_id?: string;
      chat_id?: string;
      message_type?: string;
      content?: string;
      parent_id?: string;
    };
  };
};

export function pickSenderId(payload: FeishuMessageEventPayload): string | undefined {
  return (
    payload.event?.sender?.sender_id?.open_id
    || payload.event?.sender?.sender_id?.user_id
    || payload.event?.sender?.sender_id?.union_id
    || undefined
  );
}

export function parseTextContent(raw: string | undefined): string {
  if (!raw?.trim()) return "";
  try {
    const parsed = JSON.parse(raw) as { text?: string };
    return typeof parsed.text === "string" ? parsed.text.trim() : "";
  } catch {
    return "";
  }
}

export function parsePostContent(raw: string | undefined): string {
  if (!raw?.trim()) return "";
  try {
    const parsed = JSON.parse(raw) as {
      zh_cn?: { content?: Array<Array<{ text?: string }>> };
      en_us?: { content?: Array<Array<{ text?: string }>> };
    };
    const locale = parsed.zh_cn ?? parsed.en_us;
    const rows = locale?.content ?? [];
    const texts: string[] = [];
    for (const row of rows) {
      for (const block of row) {
        if (typeof block?.text === "string" && block.text.trim()) {
          texts.push(block.text.trim());
        }
      }
    }
    return texts.join("\n").trim();
  } catch {
    return "";
  }
}
