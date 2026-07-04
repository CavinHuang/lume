import { describe, expect, test } from "bun:test";
import { generateImage, type ImageGenDeps } from "./image-gen-core";
import type { Channel } from "@lume/shared";

function makeChannel(provider: string): Channel {
  return {
    id: `ch-${provider}`,
    name: provider,
    provider: provider as any,
    baseUrl: `https://${provider}.example/v1`,
    apiKey: "encrypted",
    models: [],
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeDeps(overrides: Partial<ImageGenDeps> = {}): ImageGenDeps {
  return {
    resolveBinding: () => ({ channel: makeChannel("openai"), modelId: "gpt-image-1" }),
    decryptKey: () => "decrypted-key",
    readModelRefs: () => ["openai/gpt-image-1"],
    resolveRef: () => "/tmp/ref.png",
    callHttp: async () => ({ ok: true as const, b64: "AAAA", ext: "png" }),
    saveOutput: async () => ({
      threadPath: "files/image-gen/x.png",
      filename: "x.png",
      mediaType: "image/png",
      size: 10,
      absPath: "/tmp/x.png",
    }),
    ...overrides,
  };
}

describe("image-gen-core", () => {
  test("未配置模型时抛错", async () => {
    const deps = makeDeps({ readModelRefs: () => [] });
    await expect(
      generateImage({ workspaceSlug: "ws", threadId: "t", prompt: "x" }, deps),
    ).rejects.toThrow(/未配置图像生成模型/);
  });

  test("主模型成功，modelUsed 为主模型", async () => {
    const result = await generateImage(
      { workspaceSlug: "ws", threadId: "t", prompt: "x" },
      makeDeps(),
    );
    expect(result.modelUsed).toBe("openai/gpt-image-1");
    expect(result.mode).toBe("text-to-image");
    expect(result.images[0]?.threadPath).toBe("files/image-gen/x.png");
  });

  test("主模型失败，回退到第二个模型", async () => {
    let n = 0;
    const deps = makeDeps({
      readModelRefs: () => ["doubao/seedream", "openai/gpt-image-1"],
      callHttp: async (input) => {
        n++;
        if (n === 1) throw new Error("429");
        return { ok: true as const, url: "https://x/img.png", ext: "png" };
      },
    });
    const result = await generateImage({ workspaceSlug: "ws", threadId: "t", prompt: "x" }, deps);
    expect(result.modelUsed).toBe("openai/gpt-image-1");
  });

  test("全部失败时抛聚合错误，含每个 modelRef", async () => {
    const deps = makeDeps({
      readModelRefs: () => ["doubao/seedream", "openai/gpt-image-1"],
      callHttp: async () => { throw new Error("boom"); },
    });
    await expect(
      generateImage({ workspaceSlug: "ws", threadId: "t", prompt: "x" }, deps),
    ).rejects.toThrow(/doubao\/seedream: boom.*openai\/gpt-image-1: boom/);
  });

  test("渠道未配置/未启用的 modelRef 记为失败并继续", async () => {
    let calledFor: string | undefined;
    const deps = makeDeps({
      readModelRefs: () => ["ollama/missing", "openai/gpt-image-1"],
      resolveBinding: (ref) =>
        ref === "ollama/missing" ? null : { channel: makeChannel("openai"), modelId: "gpt-image-1" },
      callHttp: async (input) => {
        calledFor = input.model;
        return { ok: true as const, b64: "AAAA", ext: "png" };
      },
    });
    const result = await generateImage({ workspaceSlug: "ws", threadId: "t", prompt: "x" }, deps);
    expect(result.modelUsed).toBe("openai/gpt-image-1");
    expect(calledFor).toBe("gpt-image-1");
  });

  test("显式 model 优先，且去重后仍回退", async () => {
    const order: string[] = [];
    const deps = makeDeps({
      readModelRefs: () => ["openai/gpt-image-1"],
      resolveBinding: (ref) => {
        order.push(ref);
        return { channel: makeChannel("openai"), modelId: ref.split("/")[1] ?? ref };
      },
      callHttp: async (input) => {
        if (input.model === "explicit") throw new Error("fail");
        return { ok: true as const, b64: "AAAA", ext: "png" };
      },
    });
    const result = await generateImage(
      { workspaceSlug: "ws", threadId: "t", prompt: "x", model: "openai/explicit" },
      deps,
    );
    expect(order[0]).toBe("openai/explicit");
    expect(result.modelUsed).toBe("openai/gpt-image-1");
  });

  test("reference_image 存在 → 模式为 image-to-image", async () => {
    const deps = makeDeps();
    const result = await generateImage(
      { workspaceSlug: "ws", threadId: "t", prompt: "x", referenceImage: "files/ref.png" },
      deps,
    );
    expect(result.mode).toBe("image-to-image");
  });

  test("abort 时不回退，立即抛出", async () => {
    const controller = new AbortController();
    controller.abort();
    let callCount = 0;
    const deps = makeDeps({
      readModelRefs: () => ["doubao/seedream", "openai/gpt-image-1"],
      callHttp: async () => {
        callCount++;
        throw new Error("aborted");
      },
    });
    await expect(
      generateImage(
        { workspaceSlug: "ws", threadId: "t", prompt: "x", abortSignal: controller.signal },
        deps,
      ),
    ).rejects.toThrow();
    expect(callCount).toBe(1);
  });
});
