import { describe, expect, test } from "bun:test";
import { resolveAppVersion } from "./app-version";

describe("app-version", () => {
  test("应优先读取 VITE_APP_VERSION", () => {
    const version = resolveAppVersion({
      VITE_APP_VERSION: "1.2.3",
      NEXT_PUBLIC_APP_VERSION: "0.9.9"
    });
    expect(version).toBe("1.2.3");
  });

  test("VITE_APP_VERSION 缺失时应回退 NEXT_PUBLIC_APP_VERSION", () => {
    const version = resolveAppVersion({
      NEXT_PUBLIC_APP_VERSION: "0.9.9"
    });
    expect(version).toBe("0.9.9");
  });

  test("未配置版本时应返回 dev", () => {
    expect(resolveAppVersion({})).toBe("dev");
  });
});
