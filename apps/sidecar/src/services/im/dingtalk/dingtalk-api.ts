import { createLogger } from "../../infra/logger";
import { sendImSegments, splitImMessage } from "../outbound-segment";

const log = createLogger("im-dingtalk-api");

/** 出站请求显式超时(#596)：不依赖 fetch 默认(可达分钟级),失败尽快暴露。 */
const SEND_TIMEOUT_MS = 15_000;

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
  const webhook = input.contextToken;
  // #598：分段逐段发送 + 瞬时错误（网络/超时）一次重发 + 中途失败归因「已送达 N/M 段」
  return sendImSegments(splitImMessage(input.text, { maxChars: 3000 }), async (segment) => {
    try {
      const res = await fetchImpl(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content: segment } }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, error: `钉钉回复 HTTP ${res.status}: ${body}` };
      }
      // 钉钉 webhook 业务错误惯例是 HTTP 200 + errcode≠0（如 token 过期 310000），
      // 不检查会把失败当成功，回复静默丢失且桌面端收到假 sent
      const payload = (await res.json().catch(() => null)) as { errcode?: number; errmsg?: string } | null;
      if (payload && typeof payload.errcode === "number" && payload.errcode !== 0) {
        return {
          ok: false,
          error: `钉钉回复被拒(errcode ${payload.errcode})${payload.errmsg ? `: ${payload.errmsg}` : ""}`,
        };
      }
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("钉钉 sendText 段发送失败", { error: message });
      // fetch throw（网络/超时）属瞬时失败，允许一次重发
      return { ok: false, error: message, transient: true };
    }
  });
}
