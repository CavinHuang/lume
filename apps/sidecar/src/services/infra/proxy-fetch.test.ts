import { describe, expect, test } from "bun:test";
import { shouldBypassProxy } from "./proxy-fetch";

describe("proxy-fetch", () => {
  test("NO_PROXY 支持 macOS 系统代理例外列表中的通配域名", () => {
    expect(shouldBypassProxy("https://api.internal", "*.internal")).toBe(true);
    expect(shouldBypassProxy("https://deep.api.internal", "*.internal")).toBe(true);
    expect(shouldBypassProxy("https://api.example.com", "*.internal")).toBe(false);
  });
});
