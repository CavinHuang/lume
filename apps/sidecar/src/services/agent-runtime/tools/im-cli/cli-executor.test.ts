import { describe, it, expect } from "bun:test";
import { execCli, buildCliEnv, spawnCli } from "./cli-executor";

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

describe("buildCliEnv", () => {
  it("合并 env 到 process.env 基线", () => {
    const env = buildCliEnv({ LUME_TEST_INJECTED: "yes" });
    expect(env.LUME_TEST_INJECTED).toBe("yes");
  });

  it("denyList 优先级最高,即使在 env 中也移除", () => {
    const env = buildCliEnv({ KEEP_ME: "y", REMOVE_ME: "x" }, ["REMOVE_ME"]);
    expect(env.KEEP_ME).toBe("y");
    expect(env.REMOVE_ME).toBeUndefined();
  });
});

describe("spawnCli", () => {
  it("返回 ChildProcess 并透传 stdout/exit", async () => {
    const proc = spawnCli(process.execPath, ["-e", "process.stdout.write('streamed')"]);
    let out = "";
    proc.stdout?.on("data", (c: Buffer) => {
      out += c.toString();
    });
    await new Promise<void>((resolve) => proc.on("close", () => resolve()));
    expect(out).toBe("streamed");
  });

  it("envDenyList 在流式 spawn 中同样生效", async () => {
    const proc = spawnCli(
      process.execPath,
      ["-e", "process.stdout.write(process.env.LEAK ? 'LEAKED' : 'clean')"],
      { envDenyList: ["LEAK"], env: { LEAK: "secret" } },
    );
    let out = "";
    proc.stdout?.on("data", (c: Buffer) => {
      out += c.toString();
    });
    await new Promise<void>((resolve) => proc.on("close", () => resolve()));
    expect(out).toBe("clean");
  });
});
