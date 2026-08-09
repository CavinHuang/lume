import { describe, it, expect } from "bun:test";
import { dingtalkCliConfig, parseDingtalkAuthStatus } from "./dingtalk";

describe("dingtalkCliConfig", () => {
  it("包含钉钉 CLI 关键字段", () => {
    expect(dingtalkCliConfig.provider).toBe("dingtalk");
    expect(dingtalkCliConfig.binaryName).toBe("dws");
    expect(dingtalkCliConfig.npmPackage).toBe("dingtalk-workspace-cli");
    expect(dingtalkCliConfig.version).toBe("1.0.55");
    expect(dingtalkCliConfig.envDirs.DWS_CONFIG_DIR).toBe("config");
    expect(dingtalkCliConfig.envDirs.DWS_KEYCHAIN_DIR).toBe("keychain");
    expect(dingtalkCliConfig.authCommand).toEqual(["auth", "login", "--yes", "--format", "json", "--no-browser"]);
    expect(dingtalkCliConfig.statusCommand).toEqual(["auth", "status", "--format", "json"]);
    expect(dingtalkCliConfig.parseAuthStatus).toBe(parseDingtalkAuthStatus);
    expect(dingtalkCliConfig.envDenyList).toEqual([
      "DINGTALK_DWS_AGENTCODE",
      "DWS_CLIENT_ID",
      "DWS_CLIENT_SECRET",
    ]);
  });
});

describe("parseDingtalkAuthStatus", () => {
  it("已连接状态", () => {
    const out = JSON.stringify({ connected: true, profile: "corpA:userB" });
    expect(parseDingtalkAuthStatus(out)).toEqual({ connected: true, profile: "corpA:userB" });
  });
  it("statusCommand 输出 authenticated:true 也判为已连接", () => {
    expect(parseDingtalkAuthStatus(JSON.stringify({ authenticated: true })).connected).toBe(true);
  });
  it("未连接", () => {
    expect(parseDingtalkAuthStatus(JSON.stringify({ connected: false }))).toEqual({ connected: false });
  });
  it("非法 JSON 视为未连接", () => {
    expect(parseDingtalkAuthStatus("not json")).toEqual({ connected: false });
  });
});
