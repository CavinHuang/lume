import { spawn } from "node:child_process";

/**
 * 通用 IM CLI 执行器:spawn 指定 binary,统一处理 env 净化/合并、超时、stdout/stderr 收集。
 * 参照 office/office-tool-executor.ts 的 runCommand 模式。
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
  const finalEnv: Record<string, string | undefined> = { ...process.env };
  if (env) Object.assign(finalEnv, env);
  for (const key of envDenyList) delete finalEnv[key];

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
