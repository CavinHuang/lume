import { describe, it, expect } from "bun:test";
import { dingtalkCliConfig, extractDingtalkAuthUrl, parseDingtalkAuthStatus } from "./dingtalk";

describe("dingtalkCliConfig", () => {
  it("包含钉钉 CLI 关键字段", () => {
    expect(dingtalkCliConfig.provider).toBe("dingtalk");
    expect(dingtalkCliConfig.binaryName).toBe("dws");
    expect(dingtalkCliConfig.npmPackage).toBe("dingtalk-workspace-cli");
    expect(dingtalkCliConfig.version).toBe("1.0.55");
    expect(dingtalkCliConfig.envDirs.DWS_CONFIG_DIR).toBe("config");
    expect(dingtalkCliConfig.envDirs.DWS_KEYCHAIN_DIR).toBe("keychain");
    expect(dingtalkCliConfig.authCommand).toEqual(["auth", "login", "--yes", "--format", "json", "--no-browser"]);
    expect(dingtalkCliConfig.envDenyList).toEqual([
      "DINGTALK_DWS_AGENTCODE",
      "DWS_CLIENT_ID",
      "DWS_CLIENT_SECRET",
    ]);
  });
});

describe("extractDingtalkAuthUrl", () => {
  it("从含 OAuth URL 的 stdout 中提取完整 URL", () => {
    const out = `启动中...\n请访问 https://login.dingtalk.com/oauth2/auth?client_id=xxx&redirect_uri=yyy 完成授权\n等待...`;
    expect(extractDingtalkAuthUrl(out)).toBe(
      "https://login.dingtalk.com/oauth2/auth?client_id=xxx&redirect_uri=yyy",
    );
  });
  it("无 URL 时返回 undefined", () => {
    expect(extractDingtalkAuthUrl("普通日志无链接")).toBeUndefined();
  });
});

describe("parseDingtalkAuthStatus", () => {
  it("已连接状态", () => {
    const out = JSON.stringify({ connected: true, profile: "corpA:userB" });
    expect(parseDingtalkAuthStatus(out)).toEqual({ connected: true, profile: "corpA:userB" });
  });
  it("未连接", () => {
    expect(parseDingtalkAuthStatus(JSON.stringify({ connected: false }))).toEqual({ connected: false });
  });
  it("非法 JSON 视为未连接", () => {
    expect(parseDingtalkAuthStatus("not json")).toEqual({ connected: false });
  });
});
