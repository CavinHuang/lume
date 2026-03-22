import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearNanoBananaConversationHistory,
  generateNanoBananaImage
} from "./nano-banana-service";
import { saveAttachment } from "./attachment-service";

describe("nano-banana-service", () => {
  let prevConfigDir: string | undefined;
  let prevFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    prevFetch = globalThis.fetch;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-nano-banana-"));
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    if (prevFetch) {
      globalThis.fetch = prevFetch;
    }
  });

  test("多轮生成时应在后续请求续接历史并注入 thoughtSignature 占位符", async () => {
    const requestBodies: unknown[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body && typeof init.body === "string") {
        requestBodies.push(JSON.parse(init.body));
      }
      if (requestBodies.length === 1) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: "第一轮完成",
                      thoughtSignature: "sig-1"
                    }
                  ]
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: "第二轮完成" }]
              }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    await generateNanoBananaImage(
      {
        conversationId: "conv-nano-1",
        prompt: "first prompt",
        useReferenceImages: false
      },
      { apiKey: "gemini-key" }
    );
    await generateNanoBananaImage(
      {
        conversationId: "conv-nano-1",
        prompt: "second prompt",
        useReferenceImages: false
      },
      { apiKey: "gemini-key" }
    );

    expect(requestBodies.length).toBe(2);
    const secondBody = requestBodies[1] as {
      contents?: Array<{
        role?: string;
        parts?: Array<{ text?: string; thoughtSignature?: string }>;
      }>;
    };
    expect(secondBody.contents?.length ?? 0).toBe(3);
    const lastUser = secondBody.contents?.[2];
    expect(lastUser?.role).toBe("user");
    const lastTextPart = lastUser?.parts?.find((part) => typeof part.text === "string");
    expect(lastTextPart?.text).toBe("second prompt");
    expect(lastTextPart?.thoughtSignature).toBe("skip_thought_signature_validator");
  });

  test("清理会话历史后应从新会话上下文发起请求", async () => {
    const requestBodies: unknown[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body && typeof init.body === "string") {
        requestBodies.push(JSON.parse(init.body));
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: "ok" }]
              }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    await generateNanoBananaImage(
      {
        conversationId: "conv-nano-2",
        prompt: "first prompt",
        useReferenceImages: false
      },
      { apiKey: "gemini-key" }
    );
    clearNanoBananaConversationHistory("conv-nano-2");
    await generateNanoBananaImage(
      {
        conversationId: "conv-nano-2",
        prompt: "second prompt",
        useReferenceImages: false
      },
      { apiKey: "gemini-key" }
    );

    expect(requestBodies.length).toBe(2);
    const secondBody = requestBodies[1] as { contents?: unknown[] };
    expect(secondBody.contents?.length ?? 0).toBe(1);
  });

  test("参考图应按当前>上一轮assistant>上一轮user优先并限制最多4张", async () => {
    const requestBodies: unknown[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body && typeof init.body === "string") {
        requestBodies.push(JSON.parse(init.body));
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: "ok" }]
              }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const conversationId = "conv-nano-ref-priority";
    const previousUserAttachments = [
      saveAttachment({ conversationId, filename: "u1.png", mediaType: "image/png", data: "QQ==" }).attachment,
      saveAttachment({ conversationId, filename: "u2.png", mediaType: "image/png", data: "Qg==" }).attachment
    ];
    const previousAssistantAttachments = [
      saveAttachment({ conversationId, filename: "a1.png", mediaType: "image/png", data: "Qw==" }).attachment,
      saveAttachment({ conversationId, filename: "a2.png", mediaType: "image/png", data: "RA==" }).attachment
    ];
    const currentAttachments = [
      saveAttachment({ conversationId, filename: "c1.png", mediaType: "image/png", data: "RQ==" }).attachment,
      saveAttachment({ conversationId, filename: "c2.png", mediaType: "image/png", data: "Rg==" }).attachment
    ];

    await generateNanoBananaImage(
      {
        conversationId,
        prompt: "edit this image",
        useReferenceImages: true,
        currentAttachments,
        previousAssistantAttachments,
        previousUserAttachments
      },
      { apiKey: "gemini-key" }
    );

    const body = requestBodies[0] as {
      contents?: Array<{
        parts?: Array<{
          inlineData?: { data?: string };
          text?: string;
        }>;
      }>;
    };
    const parts = body.contents?.[0]?.parts ?? [];
    const inlineParts = parts.filter((item) => item.inlineData?.data).map((item) => item.inlineData?.data);

    expect(inlineParts.length).toBe(4);
    expect(inlineParts[0]).toBe("RQ==");
    expect(inlineParts[1]).toBe("Rg==");
    expect(inlineParts[2]).toBe("Qw==");
    expect(inlineParts[3]).toBe("RA==");
  });
});
