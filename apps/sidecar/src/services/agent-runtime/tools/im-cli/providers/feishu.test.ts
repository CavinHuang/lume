import { describe, it, expect } from "bun:test";
import { larkCliConfig, extractLarkAuthUrl, parseLarkAuthStatus } from "./feishu";

describe("larkCliConfig", () => {
  it("飞书 provider 配置正确", () => {
    expect(larkCliConfig.provider).toBe("feishu");
    expect(larkCliConfig.binaryName).toBe("lark-cli");
    expect(larkCliConfig.envDirs.LARKSUITE_CLI_CONFIG_DIR).toBe("config");
    expect(larkCliConfig.authCommand).toContain("login");
    expect(larkCliConfig.envDirs).not.toHaveProperty("DWS_KEYCHAIN_DIR");
  });
});

describe("extractLarkAuthUrl", () => {
  it("从混合日志提取 feishu.cn 登录 URL", () => {
    const stdout = "Opening browser... Visit: https://open.feishu.cn/connect/qrcli/auth?code=xyz to login";
    expect(extractLarkAuthUrl(stdout)).toContain("feishu.cn");
  });

  it("larksuite.com 域名也匹配", () => {
    const stdout = "Please open https://accounts.larksuite.com/login?redirect=abc";
    expect(extractLarkAuthUrl(stdout)).toContain("larksuite.com");
  });

  it("无 URL 时返回 undefined", () => {
    expect(extractLarkAuthUrl("no url here")).toBeUndefined();
  });
});

describe("parseLarkAuthStatus", () => {
  it("connected:true 时返回 connected + profile", () => {
    expect(parseLarkAuthStatus('info: check\n{"connected":true,"profile":"me@corp"}'))
      .toEqual({ connected: true, profile: "me@corp" });
  });

  it("loggedIn:true 也判为 connected", () => {
    expect(parseLarkAuthStatus('{"loggedIn":true}').connected).toBe(true);
  });

  it("无 JSON 时 disconnected", () => {
    expect(parseLarkAuthStatus("not logged in").connected).toBe(false);
  });

  it("损坏 JSON 时 disconnected", () => {
    expect(parseLarkAuthStatus("{not valid json").connected).toBe(false);
  });
});
