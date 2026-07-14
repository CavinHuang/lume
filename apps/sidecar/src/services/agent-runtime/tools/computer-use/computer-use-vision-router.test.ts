import { describe, expect, test } from "bun:test";
import type { LLMProvider } from "@lume/agent-sdk";
import { ComputerUseVisionRouter } from "./computer-use-vision-router";

describe("ComputerUseVisionRouter", () => {
  test("probes the current model once per channel version and injects only the next request", async () => {
    let probes = 0;
    const router = new ComputerUseVisionRouter({
      attempts: [{
        key: "channel-1:model-1:updated-10",
        current: true,
        probe: async () => { probes += 1; return true; },
        analyze: async () => { throw new Error("current model should receive the image in-band"); },
      }],
    });

    expect(await router.route("C:/thread/shot.png")).toEqual({ status: "image_ready" });
    expect(await router.route("C:/thread/shot-2.png")).toEqual({ status: "image_ready" });
    expect(probes).toBe(1);
  });

  test("does not cache an incomplete probe as unsupported", async () => {
    let probes = 0;
    const router = new ComputerUseVisionRouter({
      attempts: [{
        key: "reasoning-model",
        current: true,
        probe: async () => {
          probes += 1;
          if (probes === 1) throw new Error("vision_probe_incomplete:max_tokens");
          return true;
        },
        analyze: async () => undefined,
      }],
    });

    expect(await router.route("C:/thread/shot-1.png")).toEqual({ status: "vision_unavailable" });
    expect(await router.route("C:/thread/shot-2.png")).toEqual({ status: "image_ready" });
    expect(probes).toBe(2);
  });

  test("treats a max_tokens probe response as incomplete", async () => {
    const visionModule = await import("./computer-use-vision-router");
    const probe = (visionModule as Record<string, unknown>).probeVision;
    expect(probe).toBeFunction();
    const probeFunction = probe as (provider: LLMProvider, model: string) => Promise<boolean>;

    let maxTokens = 0;
    let probeDimensions = { width: 0, height: 0 };
    const provider = {
      createMessage: async (request: {
        maxTokens: number;
        messages: Array<{ content: Array<{ source?: { data?: string } }> }>;
      }) => {
        maxTokens = request.maxTokens;
        const png = Buffer.from(request.messages[0]?.content[0]?.source?.data ?? "", "base64");
        probeDimensions = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
        return { stopReason: "max_tokens", content: [] };
      },
    } as unknown as LLMProvider;

    await expect(probeFunction(provider, "step-3.7-flash")).rejects.toThrow(
      "vision_probe_incomplete:max_tokens",
    );
    expect(maxTokens).toBe(300);
    expect(probeDimensions.width).toBeGreaterThanOrEqual(512);
    expect(probeDimensions.height).toBeGreaterThanOrEqual(256);
  });

  test("accepts the expected colors when a visual model adds prose or punctuation", async () => {
    const visionModule = await import("./computer-use-vision-router");
    const probe = (visionModule as Record<string, unknown>).probeVision;
    expect(probe).toBeFunction();
    const probeFunction = probe as (provider: LLMProvider, model: string) => Promise<boolean>;
    const provider = {
      createMessage: async () => ({
        stopReason: "end_turn",
        content: [{ type: "text", text: "The colors are RED, BLUE, GREEN, and YELLOW." }],
      }),
    } as unknown as LLMProvider;

    expect(await probeFunction(provider, "visual-model")).toBe(true);
  });

  test("falls back to a verified independent vision model", async () => {
    const calls: string[] = [];
    const router = new ComputerUseVisionRouter({
      attempts: [
        {
          key: "current",
          current: true,
          probe: async () => { calls.push("probe-current"); return false; },
          analyze: async () => undefined,
        },
        {
          key: "fallback",
          current: false,
          probe: async () => { calls.push("probe-fallback"); return true; },
          analyze: async (path) => {
            calls.push(path);
            return {
              summary: "对话在讨论新工作",
              visibleText: "你女儿要有工作了",
              regions: [{ kind: "message", label: "最新回复", bounds: { x: 10, y: 20, width: 30, height: 40 }, confidence: 0.9 }],
            };
          },
        },
      ],
    });

    expect(await router.route("C:/thread/wechat.png")).toMatchObject({
      status: "observed",
      observation: { summary: "对话在讨论新工作" },
      modelKey: "fallback",
    });
    expect(calls).toEqual(["probe-current", "probe-fallback", "C:/thread/wechat.png"]);
  });

  test("returns vision_unavailable instead of guessing", async () => {
    const router = new ComputerUseVisionRouter({ attempts: [] });
    expect(await router.route("C:/thread/shot.png")).toEqual({ status: "vision_unavailable" });
  });
});
