import { createCipheriv, randomBytes, createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { __internal } from "./feishu-ingress-service";

describe("channel-gateway feishu ingress parser", () => {
  test("应解析文本消息为 inbound event", () => {
    const event = __internal.toInboundEvent({
      schema: "2.0",
      header: {
        event_id: "evt_1",
        event_type: "im.message.receive_v1"
      },
      event: {
        sender: {
          sender_id: {
            open_id: "ou_1"
          }
        },
        message: {
          message_id: "om_1",
          chat_id: "oc_1",
          message_type: "text",
          content: JSON.stringify({ text: "hello lume" })
        }
      }
    });

    expect(event).not.toBeNull();
    expect(event?.provider).toBe("feishu");
    expect(event?.externalChatId).toBe("oc_1");
    expect(event?.externalMessageId).toBe("om_1");
    expect(event?.externalUserId).toBe("ou_1");
    expect(event?.text).toBe("hello lume");
  });

  test("非文本消息应忽略", () => {
    const event = __internal.toInboundEvent({
      schema: "2.0",
      header: {
        event_id: "evt_2",
        event_type: "im.message.receive_v1"
      },
      event: {
        message: {
          message_id: "om_2",
          chat_id: "oc_2",
          message_type: "image",
          content: "{}"
        }
      }
    });
    expect(event).toBeNull();
  });

  test("应解析 post 富文本为 inbound event", () => {
    const event = __internal.toInboundEvent({
      schema: "2.0",
      header: {
        event_id: "evt_post_1",
        event_type: "im.message.receive_v1"
      },
      event: {
        sender: {
          sender_id: {
            open_id: "ou_post_1"
          }
        },
        message: {
          message_id: "om_post_1",
          chat_id: "oc_post_1",
          message_type: "post",
          content: JSON.stringify({
            zh_cn: {
              content: [
                [{ text: "第一行" }],
                [{ text: "第二行" }]
              ]
            }
          })
        }
      }
    });

    expect(event).not.toBeNull();
    expect(event?.text).toBe("第一行\n第二行");
  });

  test("应校验签名", () => {
    const body = JSON.stringify({ token: "t", event: {} });
    const timestamp = "1700000000";
    const nonce = "nonce";
    const encryptKey = "encrypt_key_123";
    const signature = createHash("sha256")
      .update(`${timestamp}${nonce}${encryptKey}${body}`)
      .digest("hex");

    const ok = __internal.verifyRequestSignature(
      body,
      {
        headers: {
          "x-lark-request-timestamp": timestamp,
          "x-lark-request-nonce": nonce,
          "x-lark-signature": signature
        }
      } as unknown as Parameters<typeof __internal.verifyRequestSignature>[1],
      {
        version: 1,
        enabled: true,
        appId: "app_id",
        appSecret: "app_secret",
        verificationToken: "verify_token",
        encryptKey,
        domain: "feishu",
        webhookPath: "/webhook/feishu"
      }
    );
    expect(ok).toBeTrue();
  });

  test("应解密 encrypt payload", () => {
    const encryptKey = Buffer.from(randomBytes(32)).toString("base64");
    const aesKey = Buffer.from(encryptKey, "base64");
    const iv = aesKey.subarray(0, 16);
    const payload = JSON.stringify({ type: "url_verification", challenge: "abc", token: "vt" });
    const payloadBuffer = Buffer.from(payload);
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32BE(payloadBuffer.length, 0);
    const appIdSuffix = Buffer.from("cli_test");
    const plain = Buffer.concat([randomBytes(16), lengthBuffer, payloadBuffer, appIdSuffix]);
    const remainder = plain.length % 32;
    const padLength = remainder === 0 ? 32 : 32 - remainder;
    const pad = Buffer.alloc(padLength, padLength);
    const padded = Buffer.concat([plain, pad]);
    const cipher = createCipheriv("aes-256-cbc", aesKey, iv);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");

    const decrypted = __internal.decryptFeishuPayload(encrypted, encryptKey) as { challenge?: string };
    expect(decrypted.challenge).toBe("abc");
  });
});
