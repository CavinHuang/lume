import type { FeishuGatewayConfig, FeishuGatewayTestResult } from "@lume/shared";
import { getFeishuGatewayConfig } from "./feishu-config-manager";

interface FeishuTenantTokenResponse {
  code: number;
  msg: string;
  tenant_access_token?: string;
  expire?: number;
}

interface FeishuBotInfoResponse {
  code: number;
  msg: string;
  bot?: {
    open_id?: string;
    name?: string;
  };
  tenant_name?: string;
}

interface TenantTokenCacheItem {
  token: string;
  expireAt: number;
}

let tokenCache: TenantTokenCacheItem | null = null;
let tokenCacheKey = "";

function domainBaseUrl(domain: FeishuGatewayConfig["domain"]): string {
  return domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
}

function ensureConfigured(config: FeishuGatewayConfig): void {
  if (!config.enabled) throw new Error("飞书渠道网关未启用");
  if (!config.appId.trim()) throw new Error("飞书 appId 未配置");
  if (!config.appSecret.trim()) throw new Error("飞书 appSecret 未配置");
  if (!config.verificationToken.trim()) throw new Error("飞书 verificationToken 未配置");
}

async function fetchTenantAccessToken(config: FeishuGatewayConfig): Promise<TenantTokenCacheItem> {
  const baseUrl = domainBaseUrl(config.domain);
  const response = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      app_id: config.appId,
      app_secret: config.appSecret
    })
  });
  if (!response.ok) {
    throw new Error(`获取飞书 tenant_access_token 失败 (${response.status})`);
  }
  const payload = await response.json() as FeishuTenantTokenResponse;
  if (payload.code !== 0 || !payload.tenant_access_token) {
    throw new Error(`获取飞书 tenant_access_token 失败: ${payload.msg || "unknown error"}`);
  }
  return {
    token: payload.tenant_access_token,
    expireAt: Date.now() + Math.max(60, payload.expire ?? 7200) * 1000
  };
}

async function getTenantAccessToken(config: FeishuGatewayConfig): Promise<string> {
  const cacheKey = `${config.domain}:${config.appId}:${config.appSecret}`;
  if (tokenCache && tokenCacheKey === cacheKey && tokenCache.expireAt - Date.now() > 60_000) {
    return tokenCache.token;
  }
  const fresh = await fetchTenantAccessToken(config);
  tokenCache = fresh;
  tokenCacheKey = cacheKey;
  return fresh.token;
}

export async function testFeishuGatewayConnection(): Promise<FeishuGatewayTestResult> {
  const config = getFeishuGatewayConfig();
  ensureConfigured(config);
  const token = await getTenantAccessToken(config);
  const baseUrl = domainBaseUrl(config.domain);
  const response = await fetch(`${baseUrl}/open-apis/bot/v3/info`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) {
    return { success: false, message: `调用 bot info 失败 (${response.status})` };
  }
  const payload = await response.json() as FeishuBotInfoResponse;
  if (payload.code !== 0) {
    return { success: false, message: `飞书返回错误: ${payload.msg || "unknown"}` };
  }
  return {
    success: true,
    message: "飞书连通性正常",
    botOpenId: payload.bot?.open_id,
    tenantName: payload.tenant_name
  };
}

export async function sendFeishuTextMessage(input: {
  chatId: string;
  text: string;
  replyToMessageId?: string;
}): Promise<{ messageId: string }> {
  const config = getFeishuGatewayConfig();
  ensureConfigured(config);
  const token = await getTenantAccessToken(config);
  const baseUrl = domainBaseUrl(config.domain);
  const content = JSON.stringify({ text: input.text });

  const response = input.replyToMessageId
    ? await fetch(`${baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(input.replyToMessageId)}/reply`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        content,
        msg_type: "text"
      })
    })
    : await fetch(`${baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        receive_id: input.chatId,
        content,
        msg_type: "text"
      })
    });

  if (!response.ok) {
    throw new Error(`飞书发送失败 (${response.status})`);
  }
  const payload = await response.json() as {
    code?: number;
    msg?: string;
    data?: { message_id?: string };
  };
  if (payload.code !== 0 || !payload.data?.message_id) {
    throw new Error(`飞书发送失败: ${payload.msg || "unknown error"}`);
  }
  return { messageId: payload.data.message_id };
}

export const __internal = {
  domainBaseUrl,
  fetchTenantAccessToken
};
