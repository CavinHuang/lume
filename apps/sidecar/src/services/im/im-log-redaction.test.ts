import { describe, expect, test } from "bun:test";
import { redactSensitiveError, redactSensitiveText } from "./im-log-redaction";

describe("redactSensitiveText", () => {
  test("钉钉 sessionWebhook 的 access_token 被掩码，URL 结构保留", () => {
    const input =
      "POST https://oapi.dingtalk.com/robot/send?access_token=abcdef1234567890abcdef1234567890 failed with 403";
    const out = redactSensitiveText(input);
    expect(out).toContain("access_token=abcd***");
    expect(out).not.toContain("abcdef1234567890");
    expect(out).toContain("https://oapi.dingtalk.com/robot/send");
  });

  test("普通查询参数不受影响", () => {
    const input = "GET https://example.com/api?page=2&size=100&tab=name";
    expect(redactSensitiveText(input)).toBe(input);
  });

  test("Authorization 头（日志与 JSON 形态）脱敏", () => {
    expect(redactSensitiveText('Authorization: Bearer sk-abcdef123456')).toBe("Authorization: ***");
    expect(redactSensitiveText('"authorization":"Bearer abc123def456"')).toContain("***");
  });

  test("无敏感内容的普通错误原样返回；短值不掩码", () => {
    expect(redactSensitiveText("connect ECONNREFUSED")).toBe("connect ECONNREFUSED");
    expect(redactSensitiveText("https://x/?a=bb&token=cc")).toContain("a=bb");
  });

  test("redactSensitiveError 接受 Error 实例", () => {
    expect(redactSensitiveError(new Error("webhook ?access_token=zzzz1111yyyy2222 expired"))).toContain(
      "token=zzzz***"
    );
  });
});
