import { describe, expect, test } from "bun:test";
import { formatConsoleArgs, formatStructuredLogLine } from "./log-format";

describe("log-format", () => {
  test("应输出带 source 与 context 的详细单行日志", () => {
    const line = formatStructuredLogLine({
      source: "sidecar",
      context: "app",
      message: "[设置] 已更新",
      data: {
        themeMode: "dark",
        onboardingCompleted: true
      }
    });

    expect(line).toBe(
      "[sidecar] [app] [设置] 已更新: {\"themeMode\":\"dark\",\"onboardingCompleted\":true}"
    );
  });

  test("应将 console 参数格式化为可读错误日志", () => {
    const line = formatConsoleArgs({
      source: "sidecar",
      context: "app",
      args: ["[代理配置] 初始化失败:", new Error("boom")]
    });

    expect(line).toContain("[sidecar] [app] [代理配置] 初始化失败:");
    expect(line).toContain("\"name\":\"Error\"");
    expect(line).toContain("\"message\":\"boom\"");
  });
});
