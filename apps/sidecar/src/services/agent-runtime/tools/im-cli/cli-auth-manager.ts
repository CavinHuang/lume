/**
 * CLI OAuth 授权管理器:两段 spawn 状态机(仿 weixinLoginManager 的 start/poll 模式)。
 *
 * ① spawn authCommand(流式)→ 扫 stdout 命中 authUrlPattern 取 OAuth URL → 立即返回(供 UI openExternal);
 * ② authCommand exit 0 → spawn statusCommand → config.parseAuthStatus 判定 connected/error。
 *
 * 子进程常驻,web 轮询 pollAuth 读内存状态。凭据由 CLI 自管 config dir(envDirs 注入)。
 * 授权是 provider 级(一个 provider 授权一次,CLI config 目录共享),与入站账号级凭据无关。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { CliAuthPhase, CliAuthPollResult, CliAuthStartResult } from "@lume/shared";
import type { CliProviderConfig } from "./providers/dingtalk";
import { spawnCli } from "./cli-executor";
import { ensureBinary, type EnsureBinaryDeps } from "./cli-binary-manager";

export type CliAuthSpawnFn = typeof spawnCli;
export type EnsureBinaryFn = typeof ensureBinary;

export interface CliAuthManagerDeps {
  /** 注入点:测试用 fake,控制 stdout/exit 时序 */
  spawn?: CliAuthSpawnFn;
  ensureBinary?: EnsureBinaryFn;
  sessionId?: () => string;
  /** 终态会话的延迟清理窗口（保留 UI 轮询终态的读取时间），测试可注入小值 */
  cleanupDelayMs?: number;
}

export interface CliAuthManager {
  startAuth(
    config: CliProviderConfig,
    userDataRoot: string,
    platform: string,
    arch: string,
    binaryDeps?: EnsureBinaryDeps,
  ): Promise<CliAuthStartResult>;
  pollAuth(sessionKey: string): CliAuthPollResult;
  cancelAuth(sessionKey: string): void;
  stopAll(): void;
}

interface AuthSession {
  sessionKey: string;
  provider: string;
  authUrl?: string;
  phase: CliAuthPhase;
  profile?: string;
  error?: string;
  authProc?: ChildProcess;
  statusProc?: ChildProcess;
  timeoutTimer?: NodeJS.Timeout;
  cleanupTimer?: NodeJS.Timeout;
  resolved?: boolean;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function buildCliAuthEnv(config: CliProviderConfig, userDataRoot: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [envName, subdir] of Object.entries(config.envDirs)) {
    env[envName] = join(userDataRoot, `${config.provider}-cli`, subdir);
  }
  return env;
}

function killSession(session: AuthSession): void {
  if (session.timeoutTimer) clearTimeout(session.timeoutTimer);
  try {
    session.authProc?.kill("SIGKILL");
  } catch {
    /* 已退出 */
  }
  try {
    session.statusProc?.kill("SIGKILL");
  } catch {
    /* 已退出 */
  }
}

export function createCliAuthManager(deps: CliAuthManagerDeps = {}): CliAuthManager {
  const spawnFn = deps.spawn ?? spawnCli;
  const ensureBinaryFn = deps.ensureBinary ?? ensureBinary;
  const sessionId = deps.sessionId ?? randomUUID;
  const cleanupDelayMs = deps.cleanupDelayMs ?? 60_000;
  const sessions = new Map<string, AuthSession>();

  /**
   * 置终态并调度延迟清理:终态(connected/error)会话无后续转移,保留 cleanupDelayMs
   * 供 UI 轮询读取,随后从 sessions 释放——防进程级 Map 只增不减。
   */
  function setTerminal(session: AuthSession, phase: "connected" | "error", error?: string): void {
    session.phase = phase;
    if (error !== undefined) session.error = error;
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    session.cleanupTimer = setTimeout(() => sessions.delete(session.sessionKey), cleanupDelayMs);
  }

  function runStatusAndFinalize(
    session: AuthSession,
    config: CliProviderConfig,
    binaryPath: string,
    userDataRoot: string,
  ): void {
    const env = buildCliAuthEnv(config, userDataRoot);
    const statusProc = spawnFn(binaryPath, config.statusCommand, {
      env,
      envDenyList: config.envDenyList,
    });
    session.statusProc = statusProc;
    let statusOut = "";
    statusProc.stdout?.on("data", (c: Buffer) => {
      statusOut += c.toString();
    });
    statusProc.on("close", () => {
      if (session.phase !== "authorizing") return; // 已被取消/超时/停止置终态
      const { connected, profile } = config.parseAuthStatus(statusOut);
      if (connected) {
        session.profile = profile;
        setTerminal(session, "connected");
      } else {
        setTerminal(session, "error", "授权未完成(CLI status 未确认连接)");
      }
    });
    statusProc.on("error", () => {
      if (session.phase !== "authorizing") return;
      setTerminal(session, "error", "状态确认命令启动失败");
    });
  }

  return {
    async startAuth(config, userDataRoot, platform, arch, binaryDeps) {
      const sessionKey = sessionId();
      const session: AuthSession = { sessionKey, provider: config.provider, phase: "authorizing" };
      sessions.set(sessionKey, session);

      let binaryPath: string;
      try {
        const r = await ensureBinaryFn(config, userDataRoot, platform, arch, binaryDeps);
        binaryPath = r.path;
      } catch (e) {
        const error = `CLI 未就绪: ${errorMessage(e)}`;
        setTerminal(session, "error", error);
        return { sessionKey, error };
      }

      const env = buildCliAuthEnv(config, userDataRoot);
      const authProc = spawnFn(binaryPath, config.authCommand, {
        env,
        envDenyList: config.envDenyList,
      });
      session.authProc = authProc;

      // 超时兜底:authTimeoutMs 内未完成则 kill 两段进程
      session.timeoutTimer = setTimeout(() => {
        killSession(session);
        if (session.phase === "authorizing") {
          setTerminal(session, "error", "授权超时");
        }
      }, config.authTimeoutMs);

      return new Promise<CliAuthStartResult>((resolve) => {
        const done = (r: CliAuthStartResult): void => {
          if (!session.resolved) {
            session.resolved = true;
            resolve(r);
          }
        };

        let buf = "";
        const onChunk = (c: Buffer): void => {
          buf += c.toString();
          if (!session.authUrl) {
            const m = buf.match(config.authUrlPattern);
            if (m) {
              session.authUrl = m[0];
              done({ sessionKey, authUrl: session.authUrl });
            }
          }
        };
        authProc.stdout?.on("data", onChunk);
        authProc.stderr?.on("data", onChunk);

        authProc.on("error", () => {
          clearTimeout(session.timeoutTimer);
          if (session.phase === "authorizing") {
            setTerminal(session, "error", "授权命令启动失败");
          }
          done({ sessionKey, error: session.error });
        });

        authProc.on("close", (code) => {
          clearTimeout(session.timeoutTimer);
          if (session.phase !== "authorizing") {
            // 已被超时/取消/停止置终态,仅确保 startAuth resolved
            done({ sessionKey, authUrl: session.authUrl, error: session.error });
            return;
          }
          if (code !== 0 && code !== null) {
            const error = `授权命令退出码 ${code}`;
            setTerminal(session, "error", error);
            done({ sessionKey, error });
            return;
          }
          // exit 0(含信号 kill 的 null):resolve startAuth,跑 statusCommand 定 phase
          done({ sessionKey, authUrl: session.authUrl });
          runStatusAndFinalize(session, config, binaryPath, userDataRoot);
        });
      });
    },

    pollAuth(sessionKey) {
      const session = sessions.get(sessionKey);
      if (!session) {
        return { phase: "error" as CliAuthPhase, error: "授权会话不存在或已结束" };
      }
      return {
        phase: session.phase,
        authUrl: session.authUrl,
        profile: session.profile,
        error: session.error,
      };
    },

    cancelAuth(sessionKey) {
      const session = sessions.get(sessionKey);
      if (!session) return;
      killSession(session);
      if (session.phase === "authorizing") {
        setTerminal(session, "error", "用户取消");
      }
    },

    stopAll() {
      for (const session of sessions.values()) {
        // 标记终态,避免 kill 触发的 close 回调再跑 statusCommand
        session.phase = "error";
        if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
        killSession(session);
      }
      sessions.clear();
    },
  };
}

export const cliAuthManager = createCliAuthManager();
