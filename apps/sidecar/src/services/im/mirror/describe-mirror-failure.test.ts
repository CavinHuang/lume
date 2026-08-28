import { describe, expect, it } from "bun:test";
import { describeImMirrorFailure } from "./describe-mirror-failure";

describe("describe-mirror-failure", () => {
  it("权限类错误码翻译为设置页可执行指引", () => {
    expect(describeImMirrorFailure("forbidden(code 99991672)")).toBe(
      "缺少 im:chat / im:message.group_msg 权限，请在飞书开放平台为该应用开通后重试"
    );
    expect(describeImMirrorFailure(new Error("(code 99991679) access denied"))).toContain(
      "缺少 im:chat"
    );
  });

  it("普通错误原样透传，空值归空串", () => {
    expect(describeImMirrorFailure("网络超时")).toBe("网络超时");
    expect(describeImMirrorFailure(new Error("boom"))).toBe("boom");
    expect(describeImMirrorFailure(undefined)).toBe("");
    expect(describeImMirrorFailure("   ")).toBe("");
  });
});
