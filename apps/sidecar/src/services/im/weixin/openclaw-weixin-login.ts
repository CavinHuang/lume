import { randomUUID } from "node:crypto";
import type {
  ImAccount,
  ImWeixinLoginPollInput,
  ImWeixinLoginPollResult,
  ImWeixinLoginStartResult,
  ImWeixinLoginStatus
} from "@lume/shared";
import {
  listImAccountSecrets,
  upsertImAccountFromLogin
} from "../im-config-manager";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface ActiveLogin {
  sessionKey: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  currentBaseUrl: string;
}

export interface WeixinLoginManager {
  startLogin(input?: { force?: boolean }): Promise<ImWeixinLoginStartResult>;
  pollLogin(input: ImWeixinLoginPollInput): Promise<ImWeixinLoginPollResult>;
}

export interface CreateOpenClawWeixinLoginManagerInput {
  fetchImpl?: FetchLike;
  localTokenProvider?: () => string[];
  upsertAccount?: (input: {
    accountKey: string;
    token: string;
    userId?: string;
    baseUrl?: string;
  }) => ImAccount;
}

const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";
const LOGIN_TTL_MS = 5 * 60_000;
const BOT_TYPE = "3";

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function loginHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "iLink-App-Id": "lume",
    "iLink-App-ClientVersion": "lume-im-weixin/0.1"
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new Error(`Weixin QR login request failed (${response.status})`);
  }
  return asRecord(await response.json());
}

function statusMessage(status: ImWeixinLoginStatus): string {
  if (status === "scaned") return "已扫码，请在手机微信确认。";
  if (status === "need_verifycode") return "需要输入手机微信显示的数字。";
  if (status === "verify_code_blocked") return "多次输入错误，请稍后重试。";
  if (status === "expired") return "二维码已过期，请重新生成。";
  if (status === "binded_redirect") return "已连接过此 OpenClaw，无需重复连接。";
  if (status === "scaned_but_redirect") return "已扫码，正在切换微信登录节点。";
  if (status === "confirmed") return "微信已连接。";
  return "等待扫码。";
}

export function createOpenClawWeixinLoginManager(
  input: CreateOpenClawWeixinLoginManagerInput = {}
): WeixinLoginManager {
  const fetchImpl = input.fetchImpl ?? fetch;
  const localTokenProvider = input.localTokenProvider ?? listImAccountSecrets;
  const upsertAccount = input.upsertAccount ?? ((payload) => upsertImAccountFromLogin({
    provider: "weixin",
    accountKey: payload.accountKey,
    label: payload.userId ? `Weixin ${payload.userId}` : `Weixin ${payload.accountKey}`,
    token: payload.token,
    uin: payload.userId,
    baseUrl: payload.baseUrl,
    enabled: true
  }));
  const activeLogins = new Map<string, ActiveLogin>();

  function purgeExpired(): void {
    const now = Date.now();
    for (const [sessionKey, login] of activeLogins) {
      if (now - login.startedAt > LOGIN_TTL_MS) {
        activeLogins.delete(sessionKey);
      }
    }
  }

  return {
    async startLogin() {
      purgeExpired();
      const sessionKey = randomUUID();
      const url = `${FIXED_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`;
      const payload = await readJson(await fetchImpl(url, {
        method: "POST",
        headers: loginHeaders(),
        body: JSON.stringify({
          local_token_list: localTokenProvider().slice(-10)
        })
      }));
      const qrcode = asString(payload.qrcode);
      const qrcodeUrl = asString(payload.qrcode_img_content);
      if (!qrcode || !qrcodeUrl) {
        throw new Error("微信登录二维码响应缺少 qrcode");
      }
      activeLogins.set(sessionKey, {
        sessionKey,
        qrcode,
        qrcodeUrl,
        startedAt: Date.now(),
        currentBaseUrl: FIXED_BASE_URL
      });
      return {
        sessionKey,
        qrcodeUrl,
        message: "请用手机微信扫描二维码。",
        expiresAt: Date.now() + LOGIN_TTL_MS
      };
    },

    async pollLogin(input) {
      const login = activeLogins.get(input.sessionKey);
      if (!login) {
        return {
          connected: false,
          message: "当前没有进行中的微信登录，请重新生成二维码。"
        };
      }
      if (Date.now() - login.startedAt > LOGIN_TTL_MS) {
        activeLogins.delete(input.sessionKey);
        return {
          connected: false,
          status: "expired",
          message: statusMessage("expired")
        };
      }

      const url = new URL("/ilink/bot/get_qrcode_status", normalizeBaseUrl(login.currentBaseUrl));
      url.searchParams.set("qrcode", login.qrcode);
      if (input.verifyCode?.trim()) {
        url.searchParams.set("verify_code", input.verifyCode.trim());
      }
      const payload = await readJson(await fetchImpl(url.toString(), {
        method: "GET",
        headers: loginHeaders()
      }));
      const status = (asString(payload.status) ?? "wait") as ImWeixinLoginStatus;

      if (status === "scaned_but_redirect") {
        const redirectHost = asString(payload.redirect_host);
        if (redirectHost) {
          login.currentBaseUrl = `https://${redirectHost}`;
        }
        return {
          connected: false,
          status,
          message: statusMessage(status)
        };
      }

      if (status === "binded_redirect") {
        activeLogins.delete(input.sessionKey);
        return {
          connected: false,
          alreadyConnected: true,
          status,
          message: statusMessage(status)
        };
      }

      if (status === "confirmed") {
        const accountKey = asString(payload.ilink_bot_id);
        const token = asString(payload.bot_token);
        if (!accountKey || !token) {
          activeLogins.delete(input.sessionKey);
          return {
            connected: false,
            status,
            message: "微信登录确认失败：服务器未返回账号凭据。"
          };
        }
        activeLogins.delete(input.sessionKey);
        const account = upsertAccount({
          accountKey,
          token,
          userId: asString(payload.ilink_user_id),
          baseUrl: asString(payload.baseurl) ?? login.currentBaseUrl
        });
        return {
          connected: true,
          status,
          message: statusMessage(status),
          account
        };
      }

      return {
        connected: false,
        status,
        needsVerifyCode: status === "need_verifycode",
        message: statusMessage(status)
      };
    }
  };
}

export const weixinLoginManager = createOpenClawWeixinLoginManager();
