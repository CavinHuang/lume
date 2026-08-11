import { describe, expect, test } from "bun:test";
import { LOBEHUB_SERVICES, decideIconKind, initialOf, colorForSeed } from "./provider-icon";

describe("decideIconKind", () => {
  test("theSVG 覆盖的 service 优先走 community", () => {
    expect(decideIconKind("github")).toBe("community");
    expect(decideIconKind("gemini")).toBe("community");
  });
  test("大小写不敏感", () => {
    expect(decideIconKind("GITHUB")).toBe("community");
  });
  test("未知 service 走 letter", () => {
    expect(decideIconKind("some_custom_app")).toBe("letter");
  });
  test("社区和内置图标均缺失时使用本地品牌图片", () => {
    expect(decideIconKind("17track")).toBe("localImage");
    expect(decideIconKind("keen_io")).toBe("localImage");
    expect(decideIconKind("17track", false, true)).toBe("letter");
  });
  test("LOBEHUB_SERVICES 与判定一致", () => {
    expect(LOBEHUB_SERVICES).toContain("openai");
    expect(LOBEHUB_SERVICES.length).toBeGreaterThan(0);
    expect(decideIconKind("openai", true, true)).toBe("lobehub");
  });
  test("浅色背景不可见的 theSVG 图标优先使用 OOMOL 本地版本", () => {
    expect(decideIconKind("openai")).toBe("localImage");
    expect(decideIconKind("anthropic")).toBe("localImage");
    expect(decideIconKind("vercel")).toBe("localImage");
  });
});

describe("initialOf", () => {
  test("取首字母大写", () => {
    expect(initialOf("Slack")).toBe("S");
    expect(initialOf("  google")).toBe("G");
  });
  test("空串兜底 ?", () => {
    expect(initialOf("")).toBe("?");
    expect(initialOf("   ")).toBe("?");
  });
});

describe("colorForSeed", () => {
  test("稳定(同 seed 同色)", () => {
    expect(colorForSeed("github")).toBe(colorForSeed("github"));
  });
  test("返回 hex 颜色", () => {
    expect(colorForSeed("anything")).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("decideIconKind 回退", () => {
  test("通用 SaaS 品牌优先使用 theSVG", () => {
    expect(decideIconKind("github")).toBe("community");
    expect(decideIconKind("notion")).toBe("community");
  });
  test("theSVG 加载失败后回退本地品牌图片", () => {
    expect(decideIconKind("stripe", true)).toBe("localImage");
  });
  test("Simple Icons 未覆盖时使用 theSVG 社区目录", () => {
    expect(decideIconKind("amplitude")).toBe("community");
    expect(decideIconKind("apollo")).toBe("community");
  });
  test("兜底 letter", () => {
    expect(decideIconKind("totally_unknown_xyz")).toBe("letter");
  });
});
