import { describe, it, expect } from "bun:test";
import { resolveBinaryPath, ensureBinary, manualBinaryEnvName } from "./cli-binary-manager";
import { dingtalkCliConfig } from "./providers/dingtalk";

describe("resolveBinaryPath", () => {
  it("返回 userData 下按平台/架构组织的 binary 路径", () => {
    const p = resolveBinaryPath(dingtalkCliConfig, "/userdata", "darwin", "arm64");
    expect(p).toContain("dingtalk-cli");
    expect(p).toContain("darwin");
    expect(p).toContain("arm64");
    expect(p).toContain("dws");
  });
});

describe("manualBinaryEnvName", () => {
  it("生成 LUME_<PROVIDER>_CLI_BIN", () => {
    expect(manualBinaryEnvName("dingtalk")).toBe("LUME_DINGTALK_CLI_BIN");
  });
});

describe("ensureBinary", () => {
  it("LUME_<PROVIDER>_CLI_BIN env 指定已存在路径时直接返回且不下载", async () => {
    const res = await ensureBinary(
      dingtalkCliConfig, "/userdata", "darwin", "arm64",
      undefined,
      { env: { LUME_DINGTALK_CLI_BIN: process.execPath } },
    );
    expect(res.path).toBe(process.execPath);
    expect(res.downloaded).toBe(false);
  });

  it("env 指定不存在的路径时不走手动分支(进入下载分支,注入 fetchTarball)", async () => {
    // manual 不存在 → 不返回 manual;target 也不存在 → 走下载分支
    // 用每运行唯一的 userDataRoot(进程 pid)避免跨次落盘污染
    const uniqueRoot = `/tmp/lume-im-test-${process.pid}`;
    const res = await ensureBinary(
      dingtalkCliConfig, uniqueRoot, "darwin", "arm64",
      { fetchTarball: async () => Buffer.from("fake-binary") },
      { env: { LUME_DINGTALK_CLI_BIN: "/definitely/does/not/exist/bin" } },
    );
    expect(res.downloaded).toBe(true);
    expect(res.path).toContain("dws");
  });
});
