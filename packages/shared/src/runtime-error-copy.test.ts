import { describe, expect, test } from "bun:test";
import {
  humanizeRuntimeErrorMessage,
  isToolPermissionInterruptionMessage,
  TOOL_PERMISSION_TIMEOUT_PREFIX,
  USER_DENIED_TOOL_PREFIX,
} from "./runtime-error-copy";

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
    // 输入用生产同源哨兵常量拼接:humanize 侧对工具权限中断消息保持原文透传,
    // 是 web 横幅文本匹配的隐含契约(#559 收尾 single-sourcing)
    const message = `${TOOL_PERMISSION_TIMEOUT_PREFIX}: Bash`;
    expect(humanizeRuntimeErrorMessage(message)).toBe(message);
  });

  test("review P0:「内部前缀+错误码」组合形态必须命中映射", () => {
    expect(humanizeRuntimeErrorMessage("Agent Runtime 执行失败: connection_disabled")).toContain("连接配置");
    expect(humanizeRuntimeErrorMessage("Agent Runtime 执行失败: connection_api_key_unavailable")).toContain("API Key");
    expect(humanizeRuntimeErrorMessage("runtime-core: pi-ai routing exhausted without a response")).toContain("渠道");
  });

  test("review F5:「未知错误」字面量给兜底指引", () => {
    expect(humanizeRuntimeErrorMessage("未知错误")).toContain("重试");
    // 三轮 review F1:「内部前缀+未知错误」组合形态剥完同样落兜底
    expect(humanizeRuntimeErrorMessage("Agent Runtime 执行失败: 未知错误")).toContain("重试");
  });

  test("review F4:runtime-core 前缀剥离带词边界,不误伤连字符标识", () => {
    expect(humanizeRuntimeErrorMessage("runtime-core-internal metric dump")).toBe("runtime-core-internal metric dump");
  });
});

describe("isToolPermissionInterruptionMessage", () => {
  test("命中超时与拒绝两种收口形态", () => {
    expect(isToolPermissionInterruptionMessage(`${TOOL_PERMISSION_TIMEOUT_PREFIX}: Bash`)).toBe(true);
    expect(isToolPermissionInterruptionMessage(`${USER_DENIED_TOOL_PREFIX}: Write`)).toBe(true);
  });

  test("普通失败消息不误判", () => {
    expect(isToolPermissionInterruptionMessage("connection_disabled")).toBe(false);
    expect(isToolPermissionInterruptionMessage("read ENOENT: /tmp/x")).toBe(false);
    expect(isToolPermissionInterruptionMessage("")).toBe(false);
  });

  test("与 humanize 透传约定联动:判定命中的消息原文保留", () => {
    const message = `${USER_DENIED_TOOL_PREFIX}: Edit`;
    expect(isToolPermissionInterruptionMessage(message)).toBe(true);
    expect(humanizeRuntimeErrorMessage(message)).toBe(message);
  });
});
