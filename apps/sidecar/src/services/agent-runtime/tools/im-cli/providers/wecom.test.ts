import { describe, it, expect } from "bun:test";
import { wecomCliConfig, parseWecomAuthStatus } from "./wecom";

describe("wecomCliConfig", () => {
  it("企微 provider 配置正确", () => {
    expect(wecomCliConfig.provider).toBe("wecom");
    expect(wecomCliConfig.binaryName).toBe("wecom-cli");
    expect(wecomCliConfig.envDirs.WECOM_CLI_CONFIG_DIR).toBe("config");
    expect(wecomCliConfig.envDirs.WECOM_CLI_TMP_DIR).toBe("tmp");
    expect(wecomCliConfig.authCommand[0]).toBe("init");
    expect(wecomCliConfig.statusCommand).toEqual(["auth", "show", "--auth-status"]);
    expect(wecomCliConfig.parseAuthStatus).toBe(parseWecomAuthStatus);
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
  it("statusCommand 纯文本 authorized 判为 connected", () => {
    expect(parseWecomAuthStatus("authorized").connected).toBe(true);
  });

  it("无 JSON 时 disconnected", () => {
    expect(parseWecomAuthStatus("not initialized").connected).toBe(false);
  });
});
