import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { ChannelGatewayIngressStatus, ChannelInboundEvent, FeishuGatewayConfig } from "@lume/shared";
import { getFeishuGatewayConfig } from "./feishu-config-manager";
import { parsePostContent, parseTextContent, pickSenderId, type FeishuMessageEventPayload } from "./feishu-message-parser";
import { simulateChannelGatewayIngress } from "./gateway-service";

const DEFAULT_PORT = 18793;
const MAX_BODY_BYTES = 1_000_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 120;
const RATE_LIMIT_MAX_KEYS = 2048;

type FeishuVerificationPayload = {
  type?: string;
  challenge?: string;
  token?: string;
};

let server: ReturnType<typeof createServer> | null = null;
let boundPort: number | null = null;
const rateLimitCounters = new Map<string, { count: number; resetAt: number }>();

function resolvePort(defaultPort = DEFAULT_PORT): number {
  const raw = process.env.LUME_CHANNEL_GATEWAY_PORT?.trim();
  if (!raw) return defaultPort;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : defaultPort;
}

function readJsonBody(req: Parameters<Parameters<ReturnType<typeof createServer>["on"]>[1]>[0]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += String(chunk);
      if (data.length > MAX_BODY_BYTES) {
        reject(new Error("payload too large"));
      }
    });
    req.on("end", () => {
      if (!data.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error instanceof Error ? error : new Error("invalid json"));
      }
    });
    req.on("error", (error) => reject(error));
  });
}

function normalizeWebhookPath(value: string): string {
  const trimmed = value.trim() || "/webhook/feishu";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, "") || "/webhook/feishu";
}

function shouldRateLimit(remote: string): boolean {
  const now = Date.now();
  if (rateLimitCounters.size > RATE_LIMIT_MAX_KEYS) {
    for (const [key, entry] of rateLimitCounters.entries()) {
      if (entry.resetAt <= now) {
        rateLimitCounters.delete(key);
      }
    }
    if (rateLimitCounters.size > RATE_LIMIT_MAX_KEYS) {
      const first = rateLimitCounters.keys().next().value;
      if (typeof first === "string") rateLimitCounters.delete(first);
    }
  }
  const existing = rateLimitCounters.get(remote);
  if (!existing || existing.resetAt <= now) {
    rateLimitCounters.set(remote, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  existing.count += 1;
  return existing.count > RATE_LIMIT_MAX_REQUESTS;
}

function getHeader(req: Parameters<Parameters<ReturnType<typeof createServer>["on"]>[1]>[0], key: string): string {
  const hit = req.headers[key];
  return typeof hit === "string" ? hit : "";
}

function secureEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function verifyRequestToken(payloadToken: string | undefined, config: FeishuGatewayConfig): boolean {
  const expected = config.verificationToken?.trim();
  if (!expected) return false;
  return secureEqual(payloadToken?.trim() || "", expected);
}

function verifyRequestSignature(rawBody: string, req: Parameters<Parameters<ReturnType<typeof createServer>["on"]>[1]>[0], config: FeishuGatewayConfig): boolean {
  const encryptKey = config.encryptKey?.trim();
  if (!encryptKey) return true;
  const timestamp = getHeader(req, "x-lark-request-timestamp");
  const nonce = getHeader(req, "x-lark-request-nonce");
  const signature = getHeader(req, "x-lark-signature");
  if (!timestamp || !nonce || !signature) return false;
  const content = `${timestamp}${nonce}${encryptKey}${rawBody}`;
  const digest = createHash("sha256").update(content).digest("hex");
  return secureEqual(digest, signature);
}

function decodeFeishuEncryptKey(encryptKey: string): Buffer {
  const padded = encryptKey.length % 4 === 0 ? encryptKey : `${encryptKey}${"=".repeat(4 - (encryptKey.length % 4))}`;
  return Buffer.from(padded, "base64");
}

function decryptFeishuPayload(encrypt: string, encryptKey: string): unknown {
  const aesKey = decodeFeishuEncryptKey(encryptKey);
  const iv = aesKey.subarray(0, 16);
  const encrypted = Buffer.from(encrypt, "base64");
  const decipher = createDecipheriv("aes-256-cbc", aesKey, iv);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const pad = plain[plain.length - 1] ?? 0;
  const unpadded = plain.subarray(0, plain.length - pad);
  const content = unpadded.subarray(16);
  const length = content.readUInt32BE(0);
  const jsonBody = content.subarray(4, 4 + length).toString("utf8");
  return JSON.parse(jsonBody);
}

function toInboundEvent(payload: FeishuMessageEventPayload): ChannelInboundEvent | null {
  if (payload.header?.event_type !== "im.message.receive_v1") return null;
  const message = payload.event?.message;
  if (!message?.message_id || !message.chat_id) return null;
  let text = "";
  if (message.message_type === "text") {
    text = parseTextContent(message.content);
  } else if (message.message_type === "post") {
    text = parsePostContent(message.content);
  } else {
    return null;
  }
  if (!text) return null;

  return {
    id: payload.header?.event_id || message.message_id,
    provider: "feishu",
    externalChatId: message.chat_id,
    externalUserId: pickSenderId(payload),
    externalMessageId: message.message_id,
    text,
    receivedAt: Date.now(),
    metadata: {
      eventType: payload.header?.event_type,
      messageType: message.message_type,
      ...(message.parent_id ? { parentMessageId: message.parent_id } : {})
    }
  };
}

export function getFeishuIngressStatus(): ChannelGatewayIngressStatus {
  const config = getFeishuGatewayConfig();
  const webhookPath = normalizeWebhookPath(config.webhookPath);
  return {
    running: Boolean(server),
    connectionMode: "webhook" as const,
    port: boundPort,
    webhookPath,
    webhookUrl: boundPort ? `http://127.0.0.1:${boundPort}${webhookPath}` : null
  };
}

export async function startFeishuIngressServer(port = resolvePort()): Promise<ChannelGatewayIngressStatus> {
  if (server) return getFeishuIngressStatus();

  server = createServer(async (req, res) => {
    const config = getFeishuGatewayConfig();
    const webhookPath = normalizeWebhookPath(config.webhookPath);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const remote = req.socket.remoteAddress ?? "unknown";

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "channel-gateway-feishu" }));
      return;
    }
    if (req.method !== "POST" || url.pathname !== webhookPath) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, message: "not found" }));
      return;
    }
    if (shouldRateLimit(remote)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 1, msg: "Too Many Requests" }));
      return;
    }
    const contentType = getHeader(req, "content-type");
    if (!contentType.toLowerCase().includes("application/json")) {
      res.writeHead(415, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 1, msg: "Unsupported Media Type" }));
      return;
    }

    try {
      let rawBody = "";
      req.on("data", (chunk) => {
        rawBody += String(chunk);
      });
      await new Promise<void>((resolve, reject) => {
        req.on("end", () => resolve());
        req.on("error", (error) => reject(error));
      });
      if (rawBody.length > MAX_BODY_BYTES) {
        throw new Error("payload too large");
      }
      if (!verifyRequestSignature(rawBody, req, config)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 1, msg: "invalid signature" }));
        return;
      }
      const body = rawBody.trim() ? JSON.parse(rawBody) as Record<string, unknown> : {};
      const decryptedBody = (typeof body.encrypt === "string" && config.encryptKey)
        ? decryptFeishuPayload(body.encrypt, config.encryptKey)
        : body;

      const verifyPayload = decryptedBody as FeishuVerificationPayload;
      if (verifyPayload.type === "url_verification" && verifyPayload.challenge) {
        if (!verifyRequestToken(verifyPayload.token, config)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ code: 1, msg: "invalid verification token" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ challenge: verifyPayload.challenge }));
        return;
      }

      const eventPayload = decryptedBody as FeishuMessageEventPayload & { token?: string };
      if (!verifyRequestToken(eventPayload.token, config)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 1, msg: "invalid verification token" }));
        return;
      }
      const inboundEvent = toInboundEvent(eventPayload);
      if (!inboundEvent) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 0, msg: "ignored" }));
        return;
      }
      if (config.defaultWorkspaceId) {
        inboundEvent.workspaceId = config.defaultWorkspaceId;
      }

      const result = await simulateChannelGatewayIngress({ event: inboundEvent });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: result.accepted ? 0 : 1, msg: result.error ?? "ok" }));
    } catch (error) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          code: 1,
          msg: error instanceof Error ? error.message : "ingress error"
        })
      );
    }
  });

  await new Promise<void>((resolve) => server!.listen(port, "127.0.0.1", resolve));
  const addr = server.address();
  boundPort = addr && typeof addr === "object" ? addr.port : port;
  return getFeishuIngressStatus();
}

export async function stopFeishuIngressServer(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  boundPort = null;
}

export const __internal = {
  toInboundEvent,
  verifyRequestSignature,
  decryptFeishuPayload
};
