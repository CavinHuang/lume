import { describe, expect, test } from "bun:test";
import { LOBEHUB_SERVICES, decideIconKind, initialOf, colorForSeed } from "./provider-icon";

describe("decideIconKind", () => {
  test("lobehub 覆盖的 service 走 lobehub", () => {
    expect(decideIconKind("github")).toBe("lobehub");
    expect(decideIconKind("notion")).toBe("lobehub");
  });
  test("大小写不敏感", () => {
    expect(decideIconKind("GITHUB")).toBe("lobehub");
  });
  test("未知 service 有 iconUrl 走 image", () => {
    expect(decideIconKind("gmail", "https://x/g.png")).toBe("image");
  });
  test("未知 service 无 iconUrl 走 letter", () => {
    expect(decideIconKind("gmail")).toBe("letter");
  });
  test("LOBEHUB_SERVICES 与判定一致", () => {
    expect(LOBEHUB_SERVICES).toContain("github");
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
