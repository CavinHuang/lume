import { describe, expect, test } from "bun:test";
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
