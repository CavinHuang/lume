import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

type RpcResponse = {
  id?: number;
  result?: unknown;
  error?: {
    message?: string;
  };
};

type PendingCall = {
  resolve: (value: unknown) => Promise<void> | void;
  reject: (reason?: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type SidecarClient = {
  call: (method: string, params?: unknown) => Promise<unknown>;
  close: () => Promise<void>;
  stderr: () => string;
};

/**
 * #647 回归钉死：sidecar 进程级装配面。
 * - 未设 LUME_AUTOMATION_RUNNER_AUTOSTART 时既有 enabled 任务必须被排程执行；
 * - automation:run-completed 通知写入器必须恒注册（懒启动路径也要能推事件）。
 */
type SidecarClientEx = SidecarClient & {
  waitForNotification: (method: string, timeoutMs: number) => Promise<{ method: string; params: unknown }>;
};

function createSidecarClient(configDir: string, options?: { autostart?: boolean }): SidecarClientEx {
  const sidecarCwd = resolve(import.meta.dir, "../..");
  const env = { ...process.env };
  if (options?.autostart === false) {
    env.LUME_AUTOMATION_RUNNER_AUTOSTART = "false";
  } else {
    delete env.LUME_AUTOMATION_RUNNER_AUTOSTART;
  }
  const child = spawn(process.execPath, ["src/index.ts"], {
    cwd: sidecarCwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...env,
      HOME: configDir,
      USERPROFILE: configDir,
      LUME_CONFIG_DIR: configDir,
      LUME_DEFAULT_SKILLS_AUTOSTART: "false",
      LUME_IM_AUTOSTART: "false",
      LUME_LOG_FILE: "false",
      LUME_READING_RUNNER_AUTOSTART: "false"
    }
  });

  let nextId = 1;
  let stderrText = "";
  let closed = false;
  const pending = new Map<number, PendingCall>();
  const notifications: Array<{ method: string; params: unknown }> = [];
  let onNotification: ((notification: { method: string; params: unknown }) => void) | undefined;
  const rl = createInterface({ input: child.stdout });

  child.stderr.on("data", (chunk) => {
    stderrText = `${stderrText}${String(chunk)}`.slice(-4_000);
  });

  child.once("exit", () => {
    closed = true;
    for (const call of pending.values()) {
      clearTimeout(call.timeout);
      call.reject(new Error(`sidecar exited before RPC response: ${stderrText}`));
    }
    pending.clear();
  });

  rl.on("line", (line) => {
    let message: RpcResponse & { method?: string; params?: unknown };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined) {
      if (typeof message.method === "string") {
        const notification = { method: message.method, params: message.params };
        notifications.push(notification);
        onNotification?.(notification);
      }
      return;
    }
    const call = pending.get(message.id);
    if (!call) {
      return;
    }
    pending.delete(message.id);
    clearTimeout(call.timeout);
    if (message.error) {
      call.reject(new Error(message.error.message ?? "sidecar RPC error"));
      return;
    }
    void call.resolve(message.result);
  });

  const waitForNotification = (method: string, timeoutMs: number): Promise<{ method: string; params: unknown }> =>
    new Promise((resolvePromise, rejectPromise) => {
      const seen = notifications.find((item) => item.method === method);
      if (seen) {
        resolvePromise(seen);
        return;
      }
      const timer = setTimeout(() => {
        onNotification = undefined;
        rejectPromise(new Error(`等待通知超时: ${method}\n${stderrText}`));
      }, timeoutMs);
      onNotification = (notification) => {
        if (notification.method !== method) return;
        clearTimeout(timer);
        onNotification = undefined;
        resolvePromise(notification);
      };
    });

  const call = (method: string, params?: unknown): Promise<unknown> =>
    new Promise((resolvePromise, rejectPromise) => {
      if (closed || !child.stdin.writable) {
        rejectPromise(new Error(`sidecar is not writable: ${stderrText}`));
        return;
      }
      const id = nextId++;
      const timeout = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`sidecar RPC timed out: ${method}\n${stderrText}`));
      }, 5_000);
      pending.set(id, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timeout
      });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });

  const close = async (): Promise<void> => {
    rl.close();
    for (const item of pending.values()) {
      clearTimeout(item.timeout);
      item.reject(new Error("sidecar client closed"));
    }
    pending.clear();
    if (closed) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolvePromise) => {
      child.once("exit", () => resolvePromise());
      setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
        resolvePromise();
      }, 1_000);
    });
  };

  return {
    call,
    close,
    stderr: () => stderrText,
    waitForNotification
  };
}

/** 在临时配置目录种入一个已过期的一次性 enabled 任务（无模型配置 → 执行快速失败但不触网）。 */
function seedExpiredOnceJob(configDir: string): string {
  const automationDir = join(configDir, "automation");
  mkdirSync(automationDir, { recursive: true });
  const jobId = "e2e-autostart-regression-job";
  const now = Date.now();
  const job = {
    id: jobId,
    name: "entrypoint autostart regression",
    enabled: true,
    schedule: { type: "once", runAt: now - 1_000, misfirePolicy: "run_latest" },
    prompt: "#647 entrypoint regression probe",
    source: "manual",
    nextRunAt: now - 1_000,
    createdAt: now,
    updatedAt: now
  };
  writeFileSync(join(automationDir, "jobs.json"), JSON.stringify({ version: 1, jobs: [job] }), "utf-8");
  return jobId;
}

describe("sidecar Automation entrypoint (#647)", () => {
  let tempConfigDir = "";
  let sidecar: SidecarClientEx | undefined;

  beforeEach(() => {
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-automation-entrypoint-"));
  });

  afterEach(async () => {
    if (sidecar) {
      await sidecar.close();
      sidecar = undefined;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("未显式关闭 autostart 时，重启后既有 enabled 任务被排程并发出完成事件", async () => {
    const jobId = seedExpiredOnceJob(tempConfigDir);
    sidecar = createSidecarClient(tempConfigDir);

    const notification = await sidecar.waitForNotification("automation:run-completed", 30_000);

    const run = (notification.params as { run: { jobId: string; status: string } }).run;
    expect(run.jobId).toBe(jobId);
    // 无模型配置下 pickExecutionChannel 快速失败：事件到达即证明排程与执行链路已接通
    expect(run.status).toBe("failed");
  }, 45_000);

  test("autostart 显式关闭时，通知写入器仍随懒启动路径注册", async () => {
    const jobId = seedExpiredOnceJob(tempConfigDir);
    sidecar = createSidecarClient(tempConfigDir, { autostart: false });

    const waitPromise = sidecar.waitForNotification("automation:run-completed", 30_000);
    // run-now 走懒启动路径；修复前 notificationWriter 未注册，此事件永不发出
    await sidecar.call("automation:run-now", { id: jobId }).catch(() => {});
    const notification = await waitPromise;

    const run = (notification.params as { run: { jobId: string; status: string } }).run;
    expect(run.jobId).toBe(jobId);
    expect(run.status).toBe("failed");
  }, 60_000);
});
