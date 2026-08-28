import { describe, it, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { createCliAuthManager, isAllowedAuthUrlHost, type CliAuthSpawnFn, type EnsureBinaryFn } from "./cli-auth-manager";
import { dingtalkCliConfig } from "./providers/dingtalk";

interface FakeProc extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: () => void;
}

/** 模拟 ChildProcess:可控 emit stdout/close;kill 异步触发 close(null)(仿信号杀死) */
function fakeProc(): FakeProc {
  const p = new EventEmitter() as unknown as FakeProc;
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.kill = () => setImmediate(() => p.emit("close", null));
  return p;
}

function asSpawn(fn: (cmd: string, args: string[]) => FakeProc): CliAuthSpawnFn {
  return fn as unknown as CliAuthSpawnFn;
}

const fakeEnsure = (async () => ({ path: "/fake/bin", downloaded: false })) as EnsureBinaryFn;
const wait0 = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createCliAuthManager", () => {
  it("扫到 authUrl 立即返回;authProc exit 0 后 statusCommand 确认 connected", async () => {
    const authProc = fakeProc();
    const statusProc = fakeProc();
    let n = 0;
    const manager = createCliAuthManager({
      spawn: asSpawn(() => (++n === 1 ? authProc : statusProc)),
      ensureBinary: fakeEnsure,
      sessionId: () => "s1",
    });

    const startP = manager.startAuth(dingtalkCliConfig, "/data", "linux", "x64");
    await wait0();
    authProc.stdout.emit("data", Buffer.from("visit https://login.dingtalk.com/oauth2/auth?c=1 end"));
    const start = await startP;

    expect(start.sessionKey).toBe("s1");
    expect(start.authUrl).toBe("https://login.dingtalk.com/oauth2/auth?c=1");
    expect(manager.pollAuth("s1").phase).toBe("authorizing");

    authProc.emit("close", 0);
    statusProc.stdout.emit("data", Buffer.from(JSON.stringify({ authenticated: true, profile: "u1" })));
    statusProc.emit("close", 0);

    const poll = manager.pollAuth("s1");
    expect(poll.phase).toBe("connected");
    expect(poll.profile).toBe("u1");
  });

  it("authProc 非 0 退出 → error", async () => {
    const authProc = fakeProc();
    const manager = createCliAuthManager({
      spawn: asSpawn(() => authProc),
      ensureBinary: fakeEnsure,
      sessionId: () => "s2",
    });
    const startP = manager.startAuth(dingtalkCliConfig, "/data", "linux", "x64");
    await wait0();
    authProc.emit("close", 2);
    const start = await startP;
    expect(start.error).toContain("退出码 2");
    expect(manager.pollAuth("s2").phase).toBe("error");
  });

  it("ensureBinary 失败 → error,不 spawn", async () => {
    const manager = createCliAuthManager({
      spawn: asSpawn(() => {
        throw new Error("不应 spawn");
      }),
      ensureBinary: (async () => {
        throw new Error("下载失败");
      }) as EnsureBinaryFn,
      sessionId: () => "s3",
    });
    const start = await manager.startAuth(dingtalkCliConfig, "/data", "linux", "x64");
    expect(start.error).toContain("CLI 未就绪");
    expect(manager.pollAuth("s3").phase).toBe("error");
  });

  it("statusCommand 判未连接 → error", async () => {
    const authProc = fakeProc();
    const statusProc = fakeProc();
    let n = 0;
    const manager = createCliAuthManager({
      spawn: asSpawn(() => (++n === 1 ? authProc : statusProc)),
      ensureBinary: fakeEnsure,
      sessionId: () => "s4",
    });
    const startP = manager.startAuth(dingtalkCliConfig, "/data", "linux", "x64");
    await wait0();
    authProc.stdout.emit("data", Buffer.from("https://login.dingtalk.com/oauth2/auth?x=1"));
    await startP;
    authProc.emit("close", 0);
    statusProc.stdout.emit("data", Buffer.from(JSON.stringify({ authenticated: false })));
    statusProc.emit("close", 0);
    expect(manager.pollAuth("s4").phase).toBe("error");
  });

  it("cancelAuth 中止授权", async () => {
    const authProc = fakeProc();
    const manager = createCliAuthManager({
      spawn: asSpawn(() => authProc),
      ensureBinary: fakeEnsure,
      sessionId: () => "s5",
    });
    const startP = manager.startAuth(dingtalkCliConfig, "/data", "linux", "x64");
    await wait0();
    authProc.stdout.emit("data", Buffer.from("https://login.dingtalk.com/oauth2/auth?x=1"));
    await startP;
    expect(manager.pollAuth("s5").phase).toBe("authorizing");
    manager.cancelAuth("s5");
    const poll = manager.pollAuth("s5");
    expect(poll.phase).toBe("error");
    expect(poll.error).toContain("取消");
  });

  it("超时 → error", async () => {
    const authProc = fakeProc();
    const manager = createCliAuthManager({
      spawn: asSpawn(() => authProc),
      ensureBinary: fakeEnsure,
      sessionId: () => "s6",
    });
    const fastConfig = { ...dingtalkCliConfig, authTimeoutMs: 20 };
    const startP = manager.startAuth(fastConfig, "/data", "linux", "x64");
    await wait0();
    const start = await startP;
    expect(start.error).toContain("超时");
    expect(manager.pollAuth("s6").phase).toBe("error");
  });

  it("statusProc 挂起 → 状态确认超时置 error，会话不永久停在 authorizing(#536)", async () => {
    const authProc = fakeProc();
    const statusProc = fakeProc();
    let n = 0;
    const manager = createCliAuthManager({
      spawn: asSpawn(() => (++n === 1 ? authProc : statusProc)),
      ensureBinary: fakeEnsure,
      sessionId: () => "s9",
    });
    // 300ms：给 setup 段（emit close(0) 前）留足余量，避免 CI 卡顿下 auth 段
    // 定时器抢先触发造成假失败
    const fastConfig = { ...dingtalkCliConfig, authTimeoutMs: 300 };
    const startP = manager.startAuth(fastConfig, "/data", "linux", "x64");
    await wait0();
    authProc.stdout.emit("data", Buffer.from("https://login.dingtalk.com/oauth2/auth?x=1"));
    await startP;
    // authProc close(0) 清掉 auth 超时定时器并进入 status 段；statusProc 永不退出
    authProc.emit("close", 0);
    expect(manager.pollAuth("s9").phase).toBe("authorizing");
    await new Promise((resolve) => setTimeout(resolve, 450));
    const poll = manager.pollAuth("s9");
    expect(poll.phase).toBe("error");
    expect(poll.error).toContain("状态确认超时");
  }, 3000);

  it("pollAuth 未知 sessionKey → error", () => {
    const manager = createCliAuthManager({ sessionId: () => "x" });
    expect(manager.pollAuth("nope").phase).toBe("error");
  });

  it("stopAll 清理会话", async () => {
    const authProc = fakeProc();
    const manager = createCliAuthManager({
      spawn: asSpawn(() => authProc),
      ensureBinary: fakeEnsure,
      sessionId: () => "s8",
    });
    const startP = manager.startAuth(dingtalkCliConfig, "/data", "linux", "x64");
    await wait0();
    authProc.stdout.emit("data", Buffer.from("https://login.dingtalk.com/oauth2/auth?x=1"));
    await startP;
    manager.stopAll();
    expect(manager.pollAuth("s8").phase).toBe("error");
  });
});

describe("isAllowedAuthUrlHost（#598 authUrl host 白名单）", () => {
  it("白名单域与子域放行，跨域/畸形 URL 拒绝", () => {
    expect(isAllowedAuthUrlHost("https://login.dingtalk.com/oauth2/auth?x=1", ["login.dingtalk.com"])).toBe(true);
    // 合法子域放行（控制子域解析的前提是已控制父域 DNS，安全语义成立）
    expect(isAllowedAuthUrlHost("https://api.login.dingtalk.com/a", ["login.dingtalk.com"])).toBe(true);
    expect(isAllowedAuthUrlHost("https://notdingtalk.com/a", ["login.dingtalk.com"])).toBe(false);
    // 后缀伪装：login.dingtalk.com.evil.com 不是白名单子域
    expect(isAllowedAuthUrlHost("https://login.dingtalk.com.evil.com/a", ["login.dingtalk.com"])).toBe(false);
    expect(isAllowedAuthUrlHost("https://login.work.weixin.qq.com/a", ["work.weixin.qq.com"])).toBe(true);
    expect(isAllowedAuthUrlHost("https://evil.com/?x=work.weixin.qq.com", ["work.weixin.qq.com"])).toBe(false);
    expect(isAllowedAuthUrlHost("not a url", ["login.dingtalk.com"])).toBe(false);
  });
});
