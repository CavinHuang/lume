import { describe, it, expect } from "bun:test";
import { wecomCliConfig, extractWecomAuthUrl, parseWecomAuthStatus } from "./wecom";

describe("wecomCliConfig", () => {
  it("企微 provider 配置正确", () => {
    expect(wecomCliConfig.provider).toBe("wecom");
    expect(wecomCliConfig.binaryName).toBe("wecom-cli");
    expect(wecomCliConfig.envDirs.WECOM_CLI_CONFIG_DIR).toBe("config");
    expect(wecomCliConfig.envDirs.WECOM_CLI_TMP_DIR).toBe("tmp");
    expect(wecomCliConfig.authCommand[0]).toBe("init");
  });
});

describe("extractWecomAuthUrl", () => {
  it("从输出提取 work.weixin.qq.com 登录 URL", () => {
    const stdout = "请访问 https://work.weixin.qq.com/ai/qc/gen?scode=abc 完成登录";
    expect(extractWecomAuthUrl(stdout)).toContain("work.weixin.qq.com");
  });

  it("无 URL 时返回 undefined", () => {
    expect(extractWecomAuthUrl("no url")).toBeUndefined();
  });
});

describe("parseWecomAuthStatus", () => {
  it("connected:true 时返回 connected", () => {
    expect(parseWecomAuthStatus('{"connected":true,"profile":"corp/admin"}'))
      .toEqual({ connected: true, profile: "corp/admin" });
  });

  it("authenticated:true 也判为 connected", () => {
    expect(parseWecomAuthStatus('{"authenticated":true}').connected).toBe(true);
  });

  it("无 JSON 时 disconnected", () => {
    expect(parseWecomAuthStatus("not initialized").connected).toBe(false);
  });
});
