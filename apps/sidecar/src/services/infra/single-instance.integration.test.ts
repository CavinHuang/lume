import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSingleInstance } from "./single-instance";

// pidfile 路径与实现一致：getConfigDir()/sidecar.pid（受 LUME_CONFIG_DIR 影响）
import { getConfigDir } from "./config-paths";

function getPidFilePath(): string {
  return join(getConfigDir(), "sidecar.pid");
}

/**
 * 集成测试：真实拉起一个命令行含 sidecar 入口标记的常驻子进程，写入 pidfile，
 * 调 acquireSingleInstance()，验证旧进程被终止、pidfile 被当前 PID 接管。
 */
describe("acquireSingleInstance（集成）", () => {
  let prevConfigDir: string | undefined;
  let tmpRoot = "";
  let dummy: ReturnType<typeof spawn> | null = null;

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tmpRoot = mkdtempSync(join(tmpdir(), "lume-singleinst-"));
    process.env.LUME_CONFIG_DIR = join(tmpRoot, "cfg");
  });

  afterEach(() => {
    if (dummy && dummy.exitCode === null) {
      try { dummy.kill("SIGKILL"); } catch { /* ignore */ }
    }
    dummy = null;
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = "";
    }
  });

  test("发现存活的 sidecar 子进程时，SIGTERM 终止并接管 pidfile", async () => {
    // 拉起一个常驻子进程，其命令行包含 sidecar/src/index.ts（落在 tmpRoot 下以匹配标记）
    const scriptDir = join(tmpRoot, "sidecar", "src");
    mkdirSync(scriptDir, { recursive: true });
    const scriptPath = join(scriptDir, "index.ts");
    writeFileSync(scriptPath, "setInterval(() => {}, 60000);\nprocess.on('SIGTERM', () => process.exit(0));", "utf-8");

    dummy = spawn(process.execPath, [scriptPath], { stdio: "ignore" });
    const dummyPid = dummy.pid!;
    // 子进程退出的信号（Node 会自动 reap 并触发 exit；避免 zombie 让 process.kill(pid,0) 误判存活）
    const exited = new Promise<"yes">((resolve) => dummy!.once("exit", () => resolve("yes")));
    // 等子进程起来
    await new Promise((r) => setTimeout(r, 100));
    // 写入旧 pidfile
    writeFileSync(getPidFilePath(), String(dummyPid), "utf-8");

    // 执行接管
    acquireSingleInstance();

    // 旧进程应已被终止（SIGTERM/SIGKILL）；给足 acquireSingleInstance 内部 2s 等待的余量
    const result = await Promise.race([
      exited,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 3500))
    ]);
    expect(result).toBe("yes");

    // pidfile 被当前 PID 接管
    expect(existsSync(getPidFilePath())).toBe(true);
    expect(readFileSync(getPidFilePath(), "utf-8").trim()).toBe(String(process.pid));
  });

  test("pidfile 指向的 PID 已不存活：不报错，直接写入自己", () => {
    writeFileSync(getPidFilePath(), "999999", "utf-8"); // 几乎不可能存活的 PID
    expect(() => acquireSingleInstance()).not.toThrow();
    expect(readFileSync(getPidFilePath(), "utf-8").trim()).toBe(String(process.pid));
  });
});
