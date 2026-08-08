import { describe, it, expect } from "bun:test";
import { execCli } from "./cli-executor";

describe("execCli", () => {
  it("成功执行并捕获 stdout", async () => {
    const res = await execCli(process.execPath, ["-e", "process.stdout.write('hello')"]);
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("hello");
    expect(res.timedOut).toBe(false);
  });

  it("非零退出码时 ok=false", async () => {
    const res = await execCli(process.execPath, ["-e", "process.exit(3)"]);
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(3);
  });

  it("捕获 stderr", async () => {
    const res = await execCli(process.execPath, ["-e", "process.stderr.write('boom')"]);
    expect(res.stderr).toBe("boom");
  });

  it("envDenyList 即使在 env 中也强制移除(净化优先级最高)", async () => {
    const res = await execCli(
      process.execPath,
      ["-e", "process.stdout.write(process.env.SECRET_TO_REMOVE ? 'LEAKED' : 'clean')"],
      { envDenyList: ["SECRET_TO_REMOVE"], env: { SECRET_TO_REMOVE: "x", LUME_INJECTED: "y" } },
    );
    expect(res.stdout).toBe("clean");
  });

  it("env 合并注入到子进程", async () => {
    const res = await execCli(
      process.execPath,
      ["-e", "process.stdout.write(process.env.LUME_INJECTED || 'none')"],
      { env: { LUME_INJECTED: "yes" } },
    );
    expect(res.stdout).toBe("yes");
  });

  it("超时触发 SIGKILL 且 timedOut=true", async () => {
    const res = await execCli(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { timeoutMs: 200 });
    expect(res.timedOut).toBe(true);
    expect(res.ok).toBe(false);
  });
});
