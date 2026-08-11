import { describe, expect, test } from "bun:test";
import { LOBEHUB_SERVICES, decideIconKind, initialOf, colorForSeed } from "./provider-icon";

describe("decideIconKind", () => {
  test("lobehub 覆盖的 service 走 lobehub", () => {
    expect(decideIconKind("openai")).toBe("lobehub");
    expect(decideIconKind("anthropic")).toBe("lobehub");
  });
  test("大小写不敏感", () => {
    expect(decideIconKind("OPENAI")).toBe("lobehub");
  });
  test("未知 service 有 iconUrl 走 image", () => {
    expect(decideIconKind("some_custom_app", "https://x/g.png")).toBe("image");
  });
  test("未知 service 无 iconUrl 走 letter", () => {
    expect(decideIconKind("some_custom_app")).toBe("letter");
  });
  test("LOBEHUB_SERVICES 与判定一致", () => {
    expect(LOBEHUB_SERVICES).toContain("openai");
    expect(LOBEHUB_SERVICES.length).toBeGreaterThan(0);
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

describe("decideIconKind simple-icons 档", () => {
  test("通用 SaaS 品牌优先使用 simple-icons", () => {
    expect(decideIconKind("github", undefined)).toBe("simpleIcon");
    expect(decideIconKind("notion", undefined)).toBe("simpleIcon");
  });
  test("命中 simple-icons 映射返回 simpleIcon", () => {
    // stripe 在生成表但不在 lobehub → simpleIcon
    expect(decideIconKind("stripe", undefined)).toBe("simpleIcon");
  });
  test("无 logo 且有 iconUrl 返回 image", () => {
    expect(decideIconKind("some_unknown_service", "https://x/y.svg")).toBe("image");
  });
  test("兜底 letter", () => {
    expect(decideIconKind("totally_unknown_xyz", undefined)).toBe("letter");
  });
});
