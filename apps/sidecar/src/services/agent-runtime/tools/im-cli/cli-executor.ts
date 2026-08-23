import { spawn, type ChildProcess } from "node:child_process";

/**
 * 通用 IM CLI 执行器:spawn 指定 binary,统一处理 env 净化/合并、超时、stdout/stderr 收集。
 */

export interface CliExecOptions {
  /** 超时(ms),默认 2 分钟 */
  timeoutMs?: number;
  /** 注入子进程的环境变量(合并到 process.env 基线) */
  env?: Record<string, string | undefined>;
  /** 子进程 cwd */
  cwd?: string;
  /** 从最终环境中强制移除的 key(即使在 env 中也移除,用于敏感变量净化) */
  envDenyList?: string[];
}

export interface CliExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export async function execCli(
  command: string,
  args: string[],
  options: CliExecOptions = {},
): Promise<CliExecResult> {
  const { timeoutMs = 2 * 60 * 1000, env, cwd, envDenyList = [] } = options;
  // 基线 env → 合并显式 env → 最后统一移除 envDenyList(denyList 优先级最高)
  const finalEnv = buildCliEnv(env, envDenyList);

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: finalEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (c) => stdoutChunks.push(Buffer.from(c)));
    child.stderr.on("data", (c) => stderrChunks.push(Buffer.from(c)));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, stdout: "", stderr: "spawn error", exitCode: 1, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: (code ?? 1) === 0 && !timedOut,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode: code ?? 1,
        timedOut,
      });
    });
  });
}

/**
 * 构建子进程 env:基线 process.env → 合并显式 env → 移除 denyList(denyList 优先级最高)。
 * execCli 与 spawnCli 共用,保证 env 净化语义一致。
 */
export function buildCliEnv(
  env?: Record<string, string | undefined>,
  denyList?: string[],
): Record<string, string | undefined> {
  const finalEnv: Record<string, string | undefined> = { ...process.env };
  if (env) Object.assign(finalEnv, env);
  for (const key of denyList ?? []) delete finalEnv[key];
  return finalEnv;
}

/**
 * 流式 spawn:返回裸 ChildProcess,供调用方自行监听 stdout/stderr/exit(如 cli-auth-manager)。
 * env 净化与 execCli 一致(buildCliEnv);不收集输出、不设超时(由调用方管理)。
 */
export function spawnCli(
  command: string,
  args: string[],
  options: Pick<CliExecOptions, "env" | "cwd" | "envDenyList"> = {},
): ChildProcess {
  const { env, cwd, envDenyList } = options;
  return spawn(command, args, {
    cwd,
    env: buildCliEnv(env, envDenyList),
    stdio: ["ignore", "pipe", "pipe"],
  });
}
