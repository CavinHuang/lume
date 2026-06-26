import { describe, expect, test } from "bun:test";
import { resolveImageProviderProfile } from "./image-provider-profiles";

describe("image-provider-profiles", () => {
  test("openai 用默认 profile，responseFormat=b64_json", () => {
    const p = resolveImageProviderProfile("openai");
    expect(p.responseFormat).toBe("b64_json");
    expect(p.extraBody).toBeUndefined();
  });

  test("doubao 用 url 响应格式", () => {
    const p = resolveImageProviderProfile("doubao");
    expect(p.responseFormat).toBe("url");
  });

  test("stepfun 与 stepfun-coding-plan 注入特有参数", () => {
    const p = resolveImageProviderProfile("stepfun-coding-plan");
    expect(p.extraBody).toMatchObject({ steps: 8, cfg_scale: 1.0, text_mode: true });
    expect(p.extraFormFields).toMatchObject({ steps: "8", cfg_scale: "1.0", text_mode: "true" });
  });

  test("未知 provider 回退到默认 profile", () => {
    const p = resolveImageProviderProfile("ollama");
    expect(p.responseFormat).toBe("b64_json");
    expect(p.extraBody).toBeUndefined();
  });

  test("mapSize 把比例映射为像素尺寸，未命中原样返回，undefined 返回 undefined", () => {
    const p = resolveImageProviderProfile("openai");
    expect(p.mapSize?.("1:1")).toBe("1024x1024");
    expect(p.mapSize?.("16:9")).toBe("1536x1024");
    expect(p.mapSize?.("2048x2048")).toBe("2048x2048");
    expect(p.mapSize?.(undefined)).toBeUndefined();
  });
});
