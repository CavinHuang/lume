import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callImageHttp } from "./image-gen-http";
import { resolveImageProviderProfile } from "./image-provider-profiles";

const originalFetch = globalThis.fetch;

function mockFetchJson(handler: (url: string, init: RequestInit) => unknown | Promise<unknown>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = await handler(url, init ?? {});
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function mockFetchStatus(status: number, text: string) {
  globalThis.fetch = (async () =>
    new Response(text, { status, statusText: text })) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("image-gen-http", () => {
  test("文生图：POST {BaseUrl}/images/generations，JSON body 含 model/prompt/response_format", async () => {
    let captured: { url: string; body: any } = { url: "", body: {} };
    mockFetchJson((url, init) => {
      captured = { url, body: JSON.parse(String(init.body)) };
      return { data: [{ b64_json: "AAAA" }] };
    });

    const result = await callImageHttp({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "gpt-image-1",
      mode: "text-to-image",
      prompt: "a cat",
      size: "1:1",
      profile: resolveImageProviderProfile("openai"),
    });

    expect(captured.url).toBe("https://api.openai.com/v1/images/generations");
    expect(captured.body).toMatchObject({
      model: "gpt-image-1",
      prompt: "a cat",
      response_format: "b64_json",
      size: "1024x1024",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.b64).toBe("AAAA");
  });

  test("豆包 baseUrl 直接拼接（保留 /api/v3），response_format=url", async () => {
    let capturedUrl = "";
    mockFetchJson((url) => {
      capturedUrl = url;
      return { data: [{ url: "https://ark.example.com/img.png" }] };
    });

    const result = await callImageHttp({
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      apiKey: "ark-key",
      model: "seedream-3-0-t2i",
      mode: "text-to-image",
      prompt: "x",
      profile: resolveImageProviderProfile("doubao"),
    });

    expect(capturedUrl).toBe("https://ark.cn-beijing.volces.com/api/v3/images/generations");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url).toBe("https://ark.example.com/img.png");
  });

  test("StepFun 注入 extraBody 特有参数", async () => {
    let body: any = {};
    mockFetchJson((_url, init) => {
      body = JSON.parse(String(init.body));
      return { data: [{ b64_json: "BBBB" }] };
    });

    await callImageHttp({
      baseUrl: "https://api.stepfun.com/step_plan/v1",
      apiKey: "step-key",
      model: "step-image-edit-2",
      mode: "text-to-image",
      prompt: "x",
      profile: resolveImageProviderProfile("stepfun-coding-plan"),
    });

    expect(body).toMatchObject({ steps: 8, cfg_scale: 1.0, text_mode: true });
  });

  test("非 2xx 抛错（触发回退）", async () => {
    mockFetchStatus(429, "rate limited");
    await expect(
      callImageHttp({
        baseUrl: "https://api.openai.com/v1",
        apiKey: "k",
        model: "gpt-image-1",
        mode: "text-to-image",
        prompt: "x",
        profile: resolveImageProviderProfile("openai"),
      }),
    ).rejects.toThrow(/429/);
  });

  test("响应缺 data 抛错", async () => {
    mockFetchJson(() => ({ error: "bad" }));
    await expect(
      callImageHttp({
        baseUrl: "https://api.openai.com/v1",
        apiKey: "k",
        model: "gpt-image-1",
        mode: "text-to-image",
        prompt: "x",
        profile: resolveImageProviderProfile("openai"),
      }),
    ).rejects.toThrow(/缺少 data/);
  });

  test("图生图：POST {BaseUrl}/images/edits，multipart 含 model/prompt/参考图", async () => {
    const refFile = join(tmpdir(), `lume-ref-${Date.now()}.png`);
    writeFileSync(refFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    let captured: { url: string; body: FormData | null } = { url: "", body: null };
    mockFetchJson((url, init) => {
      captured = { url, body: init.body instanceof FormData ? init.body : null };
      return { data: [{ b64_json: "CCCC" }] };
    });

    try {
      const result = await callImageHttp({
        baseUrl: "https://api.openai.com/v1",
        apiKey: "k",
        model: "gpt-image-1",
        mode: "image-to-image",
        prompt: "make it watercolor",
        profile: resolveImageProviderProfile("openai"),
        referenceImageAbsPath: refFile,
      });

      expect(captured.url).toBe("https://api.openai.com/v1/images/edits");
      expect(captured.body).not.toBeNull();
      expect(captured.body!.get("model")).toBe("gpt-image-1");
      expect(captured.body!.get("prompt")).toBe("make it watercolor");
      expect(captured.body!.get("image")).toBeTruthy();
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.b64).toBe("CCCC");
    } finally {
      unlinkSync(refFile);
    }
  });

  test("编辑模式缺 referenceImageAbsPath 抛错", async () => {
    mockFetchJson(() => ({ data: [{ b64_json: "x" }] }));
    await expect(
      callImageHttp({
        baseUrl: "https://api.openai.com/v1",
        apiKey: "k",
        model: "gpt-image-1",
        mode: "edit",
        prompt: "x",
        profile: resolveImageProviderProfile("openai"),
      }),
    ).rejects.toThrow(/referenceImageAbsPath/);
  });
});
