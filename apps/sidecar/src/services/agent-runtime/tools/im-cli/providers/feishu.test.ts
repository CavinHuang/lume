import { describe, it, expect } from "bun:test";
import { larkCliConfig, parseLarkAuthStatus } from "./feishu";

describe("larkCliConfig", () => {
  it("飞书 provider 配置正确", () => {
    expect(larkCliConfig.provider).toBe("feishu");
    expect(larkCliConfig.binaryName).toBe("lark-cli");
    expect(larkCliConfig.envDirs.LARKSUITE_CLI_CONFIG_DIR).toBe("config");
    expect(larkCliConfig.authCommand).toContain("login");
    expect(larkCliConfig.statusCommand).toEqual(["auth", "status", "--json", "--verify"]);
    expect(larkCliConfig.parseAuthStatus).toBe(parseLarkAuthStatus);
    expect(larkCliConfig.envDirs).not.toHaveProperty("DWS_KEYCHAIN_DIR");
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
  it("statusCommand 输出 identity=user 判为 connected", () => {
    expect(parseLarkAuthStatus('{"identity":"user"}').connected).toBe(true);
  });
  it("identity=user 但 verified=false 不连接", () => {
    expect(parseLarkAuthStatus('{"identity":"user","verified":false}').connected).toBe(false);
  });

  it("无 JSON 时 disconnected", () => {
    expect(parseLarkAuthStatus("not logged in").connected).toBe(false);
  });

  it("损坏 JSON 时 disconnected", () => {
    expect(parseLarkAuthStatus("{not valid json").connected).toBe(false);
  });
});
