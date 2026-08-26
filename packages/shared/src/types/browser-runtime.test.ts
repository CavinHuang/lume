import { describe, expect, test } from "bun:test";
import { DEFAULT_BROWSER_SETTINGS } from "./browser-runtime";

describe("DEFAULT_BROWSER_SETTINGS", () => {
  // #602: 出厂默认必须落在受保护档——agent 打开网站前需用户确认，最低摩擦档只能由用户显式选择。
  test("browserApprovalMode 默认 alwaysAsk", () => {
    expect(DEFAULT_BROWSER_SETTINGS.browserApprovalMode).toBe("alwaysAsk");
  });
});
