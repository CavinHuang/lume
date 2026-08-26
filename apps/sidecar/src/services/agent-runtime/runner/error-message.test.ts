import { describe, expect, test } from "bun:test";
import { humanizeRuntimeErrorMessage } from "./error-message";

describe("humanizeRuntimeErrorMessage", () => {
  test("渠道 snake_case 错误码映射为人话 + 下一步指引", () => {
    expect(humanizeRuntimeErrorMessage("connection_disabled")).toContain("连接配置");
    expect(humanizeRuntimeErrorMessage("connection_api_key_unavailable")).toContain("API Key");
    expect(humanizeRuntimeErrorMessage("connection_model_disabled")).toContain("模型");
    expect(humanizeRuntimeErrorMessage("connection_oauth_credential_unavailable")).toContain("重新登录");
  });

  test("OAuth 错误带原始细节后缀仍命中前缀规则(#595 降级消息兼容)", () => {
    const message = humanizeRuntimeErrorMessage(
      "connection_oauth_credential_unavailable: refresh token expired"
    );
    expect(message).toContain("重新登录");
    expect(message).not.toContain("snake");
  });

  test("fallback 链耗尽改写为可操作信息", () => {
    const message = humanizeRuntimeErrorMessage(
      "pi-ai routing exhausted without a response"
    );
    expect(message).toContain("渠道");
    expect(message).not.toContain("pi-ai");
  });

  test("剥内部组件前缀保留原因", () => {
    expect(humanizeRuntimeErrorMessage("Agent Runtime 执行失败: 渠道不存在: ch-1"))
      .toBe("渠道不存在: ch-1");
    expect(humanizeRuntimeErrorMessage("runtime-core 未找到可用渠道。"))
      .toBe("未找到可用渠道。");
  });

  test("裸兜底文案与空消息给下一步指引", () => {
    expect(humanizeRuntimeErrorMessage("Agent SDK 执行失败")).not.toBe("");
    expect(humanizeRuntimeErrorMessage("Agent SDK 执行失败")).not.toContain("SDK");
    expect(humanizeRuntimeErrorMessage("Unknown sidecar error")).toContain("诊断日志");
    expect(humanizeRuntimeErrorMessage("  ")).toContain("重试");
  });

  test("未识别的正常错误消息透传不误伤", () => {
    expect(humanizeRuntimeErrorMessage("工具权限确认超时: Bash")).toBe("工具权限确认超时: Bash");
  });
});
