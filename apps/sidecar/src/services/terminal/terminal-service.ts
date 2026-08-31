/**
 * sidecar 终端会话服务 —— 右侧面板「终端」tab 的 node-pty 执行体。
 *
 * 结构对齐 ZCode host 进程 createTerminalService（docs/analysis/P3-wiki-terminal.md §2，
 * 提取源 R11-host-pty.js）：lazy import("node-pty") + shell 探测链 + 会话表 +
 * win32 ConPTY 双段降级（useConptyDll:true → conpty.dll 加载失败特征正则 → false）+
 * onExit 自动清理。输出 50ms 批量 flush（终端数据可能高频，逐 chunk 过 RPC 代价高）。
 *
 * 与 ZCode 的偏差（均有意为之）：
 *  - shell 探测最后一级静默回落 cmd.exe / /bin/sh（ZCode 直接抛错）——平台必有
 *    默认 shell，抛错只发生在极端损坏环境。
 *  - cwd 兜底链为 arg → HOME → tmpdir（ZCode 追加 "/" unix 兜底）。
 *  - 不做 darwin spawn-helper chmod 与默认 PATH 合并——依赖 mxc-sdk 预编译产物。
 *
 * 传输：本服务不感知 IPC；输出经构造注入的 onOutput 回调外发，退出经 onExit 回调，
 * 由 terminal-bridge.ts 落到 terminal:data / terminal:exit 通知。
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";

import {
  type TerminalCreateResult,
  type TerminalDataEvent,
  type TerminalExitEvent,
} from "@lume/shared";

/** 单次批量 flush 的输出上限（字节）：超出立即 flush，防单个 timer 窗口内无限堆积。 */
const MAX_FLUSH_BYTES = 256_000;
const DEFAULT_FLUSH_DELAY_MS = 50;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** node-pty spawn 选项最小面（含 win32 ConPTY 开关；声明见 src/types/node-pty.d.ts）。 */
export type NodePtySpawnOptions = import("node-pty").IPtySpawnOptions;

/** node-pty 模块最小结构面（测试以桩体伪造）。 */
export interface NodePtyModuleLike {
  spawn(file: string, args: readonly string[], options: NodePtySpawnOptions): PtySessionLike;
}

/** 单个 PTY 会话的最小结构面（node-pty IPty；测试以桩体伪造）。 */
export interface PtySessionLike {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
}

export interface TerminalServiceDeps {
  /** shell 探测的平台/环境/存在性全部注入，测试可钉死 win32/unix 探测链。 */
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists: (path: string) => boolean;
  homeDir: string;
  tmpDir: string;
  /** lazy 加载 node-pty（进程内缓存；失败抛 ZCode 同款文案）。 */
  loadNodePty: () => Promise<NodePtyModuleLike>;
  generateId: () => string;
  /** 输出批量 flush 间隔（0 = 逐 chunk 立即外发）。 */
  flushDelayMs: number;
  onOutput: (event: TerminalDataEvent) => void;
  /** 进程自然退出通知（显式 dispose 不发）。 */
  onExit: (event: TerminalExitEvent) => void;
}

export interface TerminalCreateOptions {
  cwd?: string | null
  cols?: number
  rows?: number
}

interface TerminalSession {
  id: string;
  pty: PtySessionLike;
  shell: string;
  cols: number;
  rows: number;
  /** 待 flush 的输出批量缓冲。 */
  pending: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

export interface TerminalService {
  create(options?: TerminalCreateOptions): Promise<TerminalCreateResult>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  /** 显式关闭会话（kill + 静默回收，不发 exit 通知）。 */
  dispose(id: string): void;
  /** 进程退出/通道断开时的全量回收。 */
  disposeAll(): void;
}

/* ── shell 探测（纯函数） ─────────────────────────────────────────────── */

/** win32：pwsh.exe → powershell.exe（沿 PATH 扫描）→ %ComSpec% → cmd.exe。 */
export function detectWindowsShell(env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string {
  const pathDirs = splitPathList(env.PATH, ";");
  for (const name of ["pwsh.exe", "powershell.exe"]) {
    const found = findOnPath(pathDirs, name, exists);
    if (found) return found;
  }
  if (typeof env.ComSpec === "string" && env.ComSpec) return env.ComSpec;
  return "cmd.exe";
}

/** unix：$SHELL → /bin/zsh → /bin/bash → /bin/sh。 */
export function detectUnixShell(env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string {
  if (typeof env.SHELL === "string" && env.SHELL) return env.SHELL;
  for (const candidate of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
    if (exists(candidate)) return candidate;
  }
  return "/bin/sh";
}

export function detectShellForPlatform(
  platformName: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): string {
  return platformName === "win32" ? detectWindowsShell(env, exists) : detectUnixShell(env, exists);
}

function splitPathList(value: string | undefined, separator: string): string[] {
  if (typeof value !== "string" || !value) return [];
  return value.split(separator).filter((dir) => dir.trim().length > 0);
}

function findOnPath(pathDirs: string[], name: string, exists: (path: string) => boolean): string | null {
  for (const dir of pathDirs) {
    const candidate = join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/* ── PTY 环境 / cwd / spawn（对齐 ZCode resolveTerminalEnv / spawnTerminalProcess） ── */

/** conpty.dll 加载失败特征（ZCode shouldFallbackFromConptyDll 同款正则）。 */
const CONPTY_DLL_FALLBACK_PATTERN =
  /conpty\.node module handle|conpty\.node module file name|cannot find conpty\.dll|error code:\s*126/i;

export function shouldFallbackFromConptyDll(error: unknown): boolean {
  return CONPTY_DLL_FALLBACK_PATTERN.test(errorMessage(error));
}

/**
 * win32 用 ConPTY（useConptyDll:true 优先，加载失败按特征正则降级 Dll:false）；
 * unix 固定 xterm-256color + utf8（Windows 不支持 encoding 选项，传了仅产生警告）。
 */
export function spawnTerminalProcess(input: {
  platform: NodeJS.Platform;
  nodePty: NodePtyModuleLike;
  shell: string;
  cols: number;
  rows: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): PtySessionLike {
  const { platform: platformName, nodePty, shell, cols, rows, cwd, env } = input;
  if (platformName !== "win32") {
    return nodePty.spawn(shell, [], { name: "xterm-256color", cols, rows, cwd, env, encoding: "utf8" });
  }
  const base: NodePtySpawnOptions = { useConpty: true, name: "xterm-256color", cols, rows, cwd, env };
  try {
    return nodePty.spawn(shell, [], { ...base, useConptyDll: true });
  } catch (error) {
    if (!shouldFallbackFromConptyDll(error)) throw error;
    return nodePty.spawn(shell, [], { ...base, useConptyDll: false });
  }
}

function isUsableUtf8Locale(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && /utf-?8/i.test(value);
}

/** 已有 locale 链（LC_ALL → LC_CTYPE → LANG）取首个 UTF-8 值，否则按平台兜底。 */
export function resolveFallbackUtf8Locale(env: NodeJS.ProcessEnv, platformName: NodeJS.Platform): string {
  for (const key of ["LC_ALL", "LC_CTYPE", "LANG"] as const) {
    if (isUsableUtf8Locale(env[key])) return env[key];
  }
  return platformName === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
}

/** 终端环境：TERM/COLORTERM 固定，CI=dumb 摘除，缺失的 UTF-8 locale 补齐（ZCode 同款）。 */
export function resolveTerminalEnv(env: NodeJS.ProcessEnv, platformName: NodeJS.Platform): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env };
  const locale = resolveFallbackUtf8Locale(env, platformName);
  result.TERM = "xterm-256color";
  result.COLORTERM = result.COLORTERM?.trim() || "truecolor";
  if (result.CI === "1" && env.TERM === "dumb") delete result.CI;
  if (!isUsableUtf8Locale(result.LANG)) result.LANG = locale;
  if (!isUsableUtf8Locale(result.LC_CTYPE)) result.LC_CTYPE = locale;
  if (result.LC_ALL !== undefined && !isUsableUtf8Locale(result.LC_ALL)) result.LC_ALL = locale;
  return result;
}

/* ── node-pty lazy 加载（进程内缓存；ZCode loadNodePtyModule 同款文案） ── */

let cachedNodePty: NodePtyModuleLike | null = null;

export async function loadBundledNodePty(): Promise<NodePtyModuleLike> {
  if (cachedNodePty) return cachedNodePty;
  try {
    const mod = (await import("node-pty")) as NodePtyModuleLike & { default?: NodePtyModuleLike };
    cachedNodePty = mod.default ?? mod;
    return cachedNodePty;
  } catch (error) {
    cachedNodePty = null;
    throw toNodePtyUnavailableError(error);
  }
}

/** ZCode loadNodePtyModule 同款失败文案（独立纯函数便于锁定形状）。 */
export function toNodePtyUnavailableError(error: unknown): Error {
  return new Error(`node-pty is unavailable in this runtime: ${errorMessage(error)}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ── 会话服务 ─────────────────────────────────────────────────────────── */

export function createTerminalService(deps: TerminalServiceDeps): TerminalService {
  const sessions = new Map<string, TerminalSession>();

  const flushSession = (session: TerminalSession): void => {
    if (session.flushTimer !== null) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    if (!session.pending) return;
    const data = session.pending;
    session.pending = "";
    deps.onOutput({ id: session.id, data });
  };

  const appendOutput = (session: TerminalSession, chunk: string): void => {
    session.pending += chunk;
    if (session.pending.length >= MAX_FLUSH_BYTES) {
      flushSession(session);
      return;
    }
    if (session.flushTimer !== null) return;
    session.flushTimer = setTimeout(() => flushSession(session), deps.flushDelayMs);
  };

  /**
   * 进程自然退出：flush + 摘表 + exit 通知。stale 守卫——显式 dispose 已先摘表，
   * kill 触发的迟到 onExit 在此静默（对齐 ZCode dispose 时序下 emitter 已释放的语义）。
   */
  const closeSession = (session: TerminalSession, exitCode: number | null): void => {
    flushSession(session);
    if (sessions.get(session.id) !== session) return;
    sessions.delete(session.id);
    deps.onExit({ id: session.id, exitCode });
  };

  return {
    async create(options: TerminalCreateOptions = {}): Promise<TerminalCreateResult> {
      const shell = detectShellForPlatform(deps.platform, deps.env, deps.exists);
      const cwd = resolveCwd(options.cwd, deps);
      const env = resolveTerminalEnv(deps.env, deps.platform);
      const nodePty = await deps.loadNodePty();
      let pty: PtySessionLike;
      try {
        pty = spawnTerminalProcess({
          platform: deps.platform,
          nodePty,
          shell,
          cols: normalizeCols(options.cols),
          rows: normalizeRows(options.rows),
          cwd,
          env,
        });
      } catch (error) {
        throw new Error(`Failed to start terminal with shell '${shell}' in '${cwd}': ${errorMessage(error)}`);
      }
      const session: TerminalSession = {
        id: deps.generateId(),
        pty,
        shell,
        cols: normalizeCols(options.cols),
        rows: normalizeRows(options.rows),
        pending: "",
        flushTimer: null,
      };
      sessions.set(session.id, session);
      pty.onData((chunk: string) => {
        appendOutput(session, chunk);
      });
      pty.onExit((event) => {
        closeSession(session, typeof event?.exitCode === "number" ? event.exitCode : null);
      });
      return { id: session.id, shell };
    },

    write(id: string, data: string): void {
      requireSession(sessions, id).pty.write(data);
    },

    resize(id: string, cols: number, rows: number): void {
      const session = requireSession(sessions, id);
      session.cols = normalizeCols(cols);
      session.rows = normalizeRows(rows);
      session.pty.resize(session.cols, session.rows);
    },

    dispose(id: string): void {
      const session = sessions.get(id);
      if (!session) return;
      // 先摘表再 kill：迟到 onExit 按 stale 守卫静默，不发 exit 通知。
      sessions.delete(id);
      flushSession(session);
      session.pty.kill();
    },

    disposeAll(): void {
      for (const session of [...sessions.values()]) {
        this.dispose(session.id);
      }
    },
  };
}

/** cwd 兜底链：入参（须存在）→ HOME → tmpdir（ZCode resolveTerminalCwd 同型）。 */
function resolveCwd(candidate: string | null | undefined, deps: TerminalServiceDeps): string {
  for (const dir of [candidate, deps.homeDir, deps.tmpDir]) {
    if (typeof dir === "string" && dir && deps.exists(dir)) return dir;
  }
  throw new Error("No usable working directory found for terminal startup");
}

/* ── 载荷规整 ─────────────────────────────────────────────────────────── */

/** 供真实装配（terminal-bridge）使用的默认依赖（真实进程环境 + bundled node-pty）。 */
export function createDefaultTerminalServiceDeps(input: {
  onOutput: (event: TerminalDataEvent) => void;
  onExit: (event: TerminalExitEvent) => void;
}): TerminalServiceDeps {
  return {
    platform: platform(),
    env: process.env,
    exists: (path) => existsSync(path),
    homeDir: homedir(),
    tmpDir: tmpdir(),
    loadNodePty: loadBundledNodePty,
    generateId: () => randomUUID(),
    flushDelayMs: DEFAULT_FLUSH_DELAY_MS,
    onOutput: input.onOutput,
    onExit: input.onExit,
  };
}

function requireSession(sessions: Map<string, TerminalSession>, id: string): TerminalSession {
  const session = sessions.get(id);
  if (!session) {
    throw Object.assign(new Error(`终端会话不存在或已退出: ${id}`), { code: "terminal_session_not_found" });
  }
  return session;
}

function normalizeCols(cols: number | undefined): number {
  return typeof cols === "number" && Number.isFinite(cols) ? Math.min(Math.max(Math.trunc(cols), 2), 500) : DEFAULT_COLS;
}

function normalizeRows(rows: number | undefined): number {
  return typeof rows === "number" && Number.isFinite(rows) ? Math.min(Math.max(Math.trunc(rows), 2), 200) : DEFAULT_ROWS;
}
