import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { getConfigDir } from "./config-paths";
import { createLogger } from "./logger";

const log = createLogger("sidecar");

/** sidecar 入口在命令行里的关键片段（POSIX / Windows 两种分隔符）。用于 PID 复用校验。 */
const SIDECAR_ENTRY_MARKERS = ["sidecar/src/index.ts", "sidecar\\src\\index.ts"];

export interface TakeoverPlan {
  killPid?: number;
  writePid: number;
}

/**
 * 纯决策：给定 pidfile 内容、当前 PID、存活判定与 sidecar 判定，返回是否需要杀旧、写入哪个 PID。
 * 抽出来便于单测；实际副作用（kill / 写文件）在 acquireSingleInstance 里执行。
 *
 * 仅当旧 PID 仍存活 **且** 命令行确属 sidecar 时才杀旧接管 —— 避免 PID 复用误杀无关进程。
 */
export function planTakeover(input: {
  pidfileContent: string | null;
  currentPid: number;
  isAlive: (pid: number) => boolean;
  isSidecar: (pid: number) => boolean;
}): TakeoverPlan {
  const raw = input.pidfileContent?.trim();
  if (raw) {
    const prevPid = Number.parseInt(raw, 10);
    if (
      Number.isInteger(prevPid) &&
      prevPid !== input.currentPid &&
      input.isAlive(prevPid) &&
      input.isSidecar(prevPid)
    ) {
      return { killPid: prevPid, writePid: input.currentPid };
    }
  }
  return { writePid: input.currentPid };
}

function getPidFilePath(): string {
  return join(getConfigDir(), "sidecar.pid");
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 取 pid 的完整命令行；跨平台；取不到返回空串。 */
function getProcessCommand(pid: number): string {
  try {
    if (process.platform === "win32") {
      const r = spawnSync("wmic", ["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/format:list"], {
        encoding: "utf-8"
      });
      return (r.stdout ?? "").trim();
    }
    const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8" });
    return (r.stdout ?? "").trim();
  } catch {
    return "";
  }
}

function isSidecarProcess(pid: number): boolean {
  const cmd = getProcessCommand(pid);
  if (!cmd) return false;
  return SIDECAR_ENTRY_MARKERS.some((marker) => cmd.includes(marker));
}

function sleepSync(ms: number): void {
  // Node 主线程允许 Atomics.wait；用于 SIGTERM 后等旧进程退出的有界等待。
  try {
    const buf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buf, 0, 0, ms);
  } catch {
    // 退化：不等。旧进程会异步退出，重叠窗口极小。
  }
}

/**
 * sidecar 单例守卫：boot 最早处调用。新实例发现仍存活的旧 sidecar 时，SIGTERM（必要时
 * SIGKILL）接管，再写入自己的 PID。根治「多个 sidecar 进程各自排程执行同一份 jobs.json，
 * 导致每个自动化任务同一时间被执行 N 次」。
 */
export function acquireSingleInstance(): void {
  const pidFile = getPidFilePath();
  let prevContent: string | null = null;
  if (existsSync(pidFile)) {
    try {
      prevContent = readFileSync(pidFile, "utf-8");
    } catch {
      prevContent = null;
    }
  }

  const plan = planTakeover({
    pidfileContent: prevContent,
    currentPid: process.pid,
    isAlive: isPidAlive,
    isSidecar: isSidecarProcess
  });

  if (plan.killPid !== undefined) {
    log.warn("检测到已有 sidecar 实例，新实例接管并终止旧实例", { prevPid: plan.killPid, currentPid: process.pid });
    try {
      process.kill(plan.killPid, "SIGTERM");
    } catch {
      // ignore
    }
    // 有界等待旧进程退出，避免新旧 runners 短暂重叠导致的一次性双执行
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && isPidAlive(plan.killPid)) {
      sleepSync(50);
    }
    if (isPidAlive(plan.killPid) && isSidecarProcess(plan.killPid)) {
      try {
        process.kill(plan.killPid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  }

  writeFileSync(pidFile, String(process.pid), "utf-8");

  // 退出时清理 pidfile，但仅当里面仍是自己的 PID（避免误删更新的实例）。
  // 绑定 "exit" 即可覆盖正常退出与 SIGTERM/SIGINT 默认终止；SIGKILL 场景 pidfile 会留为
  // 悬空，下次启动靠 isAlive 判定自愈。
  process.on("exit", () => {
    try {
      if (existsSync(pidFile) && readFileSync(pidFile, "utf-8").trim() === String(process.pid)) {
        unlinkSync(pidFile);
      }
    } catch {
      // ignore cleanup failure
    }
  });
}
