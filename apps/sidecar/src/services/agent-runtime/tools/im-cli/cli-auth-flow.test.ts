import { describe, it, expect } from "bun:test";
import { runCliAuth, type ExecCliFn } from "./cli-auth-flow";
import { dingtalkCliConfig } from "./providers/dingtalk";
import type { CliExecResult } from "./cli-executor";

const makeResult = (stdout: string): CliExecResult => ({
  ok: true,
  stdout,
  stderr: "",
  exitCode: 0,
  timedOut: false,
});

describe("runCliAuth", () => {
  it("从授权命令 stdout 提取 authUrl 并返回最终 status", async () => {
    const calls: Array<{ args: string[]; envKeys: string[]; denyList: string[] }> = [];
    const mockExec: ExecCliFn = async (_cmd, args, opts) => {
      calls.push({ args, envKeys: Object.keys(opts.env ?? {}), denyList: opts.envDenyList ?? [] });
      return makeResult(
        `请访问 https://login.dingtalk.com/oauth2/auth?cid=1 完成\n${JSON.stringify({ connected: true, profile: "c:u" })}`,
      );
    };
    const res = await runCliAuth(dingtalkCliConfig, "/fake/dws", "/u", mockExec);
    expect(res.authUrl).toContain("login.dingtalk.com/oauth2/auth");
    expect(res.status.connected).toBe(true);
    expect(res.status.profile).toBe("c:u");
    // 调用授权命令 + env 注入 + envDenyList
    expect(calls[0]?.args).toEqual(["auth", "login", "--yes", "--format", "json", "--no-browser"]);
    expect(calls[0]?.envKeys).toContain("DWS_CONFIG_DIR");
    expect(calls[0]?.envKeys).toContain("DWS_KEYCHAIN_DIR");
    expect(calls[0]?.denyList).toEqual(dingtalkCliConfig.envDenyList);
  });

  it("未授权时 connected=false", async () => {
    const mockExec: ExecCliFn = async () => makeResult(JSON.stringify({ connected: false }));
    const res = await runCliAuth(dingtalkCliConfig, "/fake/dws", "/u", mockExec);
    expect(res.status.connected).toBe(false);
    expect(res.authUrl).toBeUndefined();
  });
});
