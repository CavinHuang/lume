import { createLogger } from "../../infra/logger";
import { splitImMessage } from "../outbound-segment";

const log = createLogger("im-dingtalk-api");

export interface SendDingtalkTextInput {
  text: string;
  /** 入站 event 的 sessionWebhook(72h 临时 webhook,免 access_token);缺失则无法回复。 */
  contextToken?: string;
}

export interface DingtalkApiDeps {
  fetchImpl?: typeof fetch;
}

/**
 * 钉钉机器人出站:POST sessionWebhook(contextToken)发送文本。
 * sessionWebhook 由入站机器人 event 携带,无需 access_token,有效期约 72 小时。
 */
export async function sendDingtalkText(
  input: SendDingtalkTextInput,
  deps: DingtalkApiDeps = {},
): Promise<{ ok: boolean; error?: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (!input.contextToken) {
    return { ok: false, error: "缺少 sessionWebhook(钉钉会话已过期或未提供),无法回复" };
  }
  try {
    for (const segment of splitImMessage(input.text, { maxChars: 3000 })) {
      const res = await fetchImpl(input.contextToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content: segment } }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, error: `钉钉回复 HTTP ${res.status}: ${body}` };
      }
    }
    return { ok: true };
  } catch (error) {
    log.error("钉钉 sendText 失败", { error: error instanceof Error ? error.message : String(error) });
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
