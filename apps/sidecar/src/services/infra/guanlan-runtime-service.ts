import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getConfigDir } from "./config-paths";

const PYTHON_BUILD_DATE = "20260414";
const PYTHON_VERSION = "3.11.15";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_STDERR_CHARS = 2_000;
const MAX_STDOUT_CHARS = 200_000;

export interface GuanlanSearchResult {
  title: string;
  url: string;
  snippet?: string;
  sourceType?: string;
  evidenceRole?: string;
  domain?: string;
}

export interface GuanlanRuntimeStatus {
  ok: boolean;
  pythonPath?: string;
  guanlanVersion?: string;
  error?: string;
}

export interface GuanlanSearchInput {
  query: string;
  limit?: number;
  profile?: string;
}

export interface GuanlanCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GuanlanRunOptions {
  timeoutMs?: number;
}

export type GuanlanCommandRunner = (
  command: string,
  args: string[],
  options?: GuanlanRunOptions
) => Promise<GuanlanCommandResult>;

interface GuanlanRuntimeOptions {
  runner?: GuanlanCommandRunner;
  pythonCandidates?: string[];
  downloadPython?: () => Promise<boolean>;
}

export function createGuanlanRuntime(options: GuanlanRuntimeOptions = {}) {
  const runner = options.runner ?? runCommand;

  async function resolvePython(): Promise<string | null> {
    for (const candidate of options.pythonCandidates ?? getPythonCandidates()) {
      const result = await runner(candidate, ["--version"], { timeoutMs: 5_000 }).catch(() => null);
      if (result?.code === 0) {
        return candidate;
      }
    }
    return null;
  }

  async function readGuanlanVersion(pythonPath: string): Promise<string | null> {
    const result = await runner(pythonPath, ["-m", "guanlan", "--version"], { timeoutMs: 8_000 }).catch(() => null);
    if (result?.code !== 0) {
      return null;
    }
    return (result.stdout || result.stderr).trim() || "unknown";
  }

  async function getStatus(): Promise<GuanlanRuntimeStatus> {
    const pythonPath = await resolvePython();
    if (!pythonPath) {
      return { ok: false, error: "未找到 Python。可安装 Python 3.11+ 或配置 LUME_PYTHON。" };
    }
    const guanlanVersion = await readGuanlanVersion(pythonPath);
    if (!guanlanVersion) {
      return { ok: false, pythonPath, error: "未找到 guanlan。可通过 pip 安装 guanlan 后重试。" };
    }
    return { ok: true, pythonPath, guanlanVersion };
  }

  async function ensureReady(): Promise<GuanlanRuntimeStatus> {
    let pythonPath = await resolvePython();
    if (!pythonPath && await (options.downloadPython ?? ensureManagedPythonReady)()) {
      pythonPath = await resolvePython();
    }
    if (!pythonPath) {
      return { ok: false, error: "未找到 Python，且自动下载 Python 运行时失败。可安装 Python 3.11+ 或配置 LUME_PYTHON。" };
    }
    const currentVersion = await readGuanlanVersion(pythonPath);
    if (currentVersion) {
      return { ok: true, pythonPath, guanlanVersion: currentVersion };
    }

    const install = await runner(pythonPath, ["-m", "pip", "install", "--upgrade", "guanlan"], {
      timeoutMs: 120_000
    }).catch((error) => ({
      code: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error)
    }));
    if (install.code !== 0) {
      return {
        ok: false,
        pythonPath,
        error: `安装 guanlan 失败：${truncate(install.stderr || install.stdout, MAX_STDERR_CHARS)}`
      };
    }

    const guanlanVersion = await readGuanlanVersion(pythonPath);
    if (!guanlanVersion) {
      return { ok: false, pythonPath, error: "guanlan 安装后仍不可用。" };
    }
    return { ok: true, pythonPath, guanlanVersion };
  }

  async function search(input: GuanlanSearchInput): Promise<GuanlanSearchResult[]> {
    const ready = await ensureReady();
    if (!ready.ok || !ready.pythonPath) {
      throw new Error(ready.error ?? "guanlan 未就绪");
    }
    const limit = clampLimit(input.limit);
    const profile = input.profile?.trim() || "china";
    const result = await runner(ready.pythonPath, [
      "-m",
      "guanlan",
      "search",
      input.query,
      "--profile",
      profile,
      "--limit",
      String(limit),
      "--json"
    ], { timeoutMs: DEFAULT_TIMEOUT_MS });
    if (result.code !== 0) {
      throw new Error(`guanlan search 失败：${truncate(result.stderr || result.stdout, MAX_STDERR_CHARS)}`);
    }
    return parseGuanlanSearchOutput(result.stdout);
  }

  return { getStatus, ensureReady, search };
}

export const defaultGuanlanRuntime = createGuanlanRuntime();

export function getGuanlanRuntimeStatus(): Promise<GuanlanRuntimeStatus> {
  return defaultGuanlanRuntime.getStatus();
}

export function ensureGuanlanReady(): Promise<GuanlanRuntimeStatus> {
  return defaultGuanlanRuntime.ensureReady();
}

export function runGuanlanSearch(input: GuanlanSearchInput): Promise<GuanlanSearchResult[]> {
  return defaultGuanlanRuntime.search(input);
}

export function parseGuanlanSearchOutput(output: string): GuanlanSearchResult[] {
  const payload = parseJson(output);
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { results?: unknown[] } | null)?.results)
      ? (payload as { results: unknown[] }).results
      : [];

  return items
    .map(normalizeSearchResult)
    .filter((item): item is GuanlanSearchResult => !!item);
}

function normalizeSearchResult(item: unknown): GuanlanSearchResult | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const title = readString(record.title) || readString(record.name);
  const url = readString(record.url) || readString(record.link);
  if (!title || !url) return null;
  return {
    title,
    url,
    ...(readString(record.snippet) || readString(record.content) ? { snippet: readString(record.snippet) || readString(record.content) } : {}),
    ...(readString(record.source_type) ? { sourceType: readString(record.source_type) } : {}),
    ...(readString(record.evidence_role) ? { evidenceRole: readString(record.evidence_role) } : {}),
    ...(readString(record.domain) ? { domain: readString(record.domain) } : {})
  };
}

function getPythonCandidates(): string[] {
  const runtimeRoot = join(getConfigDir(), "runtime", "python");
  const managedCandidates = [
    join(runtimeRoot, "bin", "python3"),
    join(runtimeRoot, "python.exe")
  ].filter((candidate) => existsSync(candidate));
  return [
    process.env.LUME_PYTHON?.trim(),
    ...managedCandidates,
    "python3",
    "python"
  ].filter((item): item is string => !!item);
}

async function runCommand(command: string, args: string[], options: GuanlanRunOptions = {}): Promise<GuanlanCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8"
      }
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ code: 124, stdout, stderr: stderr || "命令执行超时" });
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => {
      stdout = truncate(stdout + chunk.toString("utf8"), MAX_STDOUT_CHARS);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = truncate(stderr + chunk.toString("utf8"), MAX_STDERR_CHARS);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ code: 127, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

async function ensureManagedPythonReady(): Promise<boolean> {
  const runtimeRoot = join(getConfigDir(), "runtime", "python");
  if (existsSync(getManagedPythonExecutable(runtimeRoot))) {
    return true;
  }

  const archiveName = getPythonStandaloneArchiveName();
  if (!archiveName) {
    return false;
  }
  const tempRoot = join(tmpdir(), "lume-python-runtime");
  const archivePath = join(tempRoot, archiveName);
  const extractPath = join(tempRoot, "extract");
  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_BUILD_DATE}/${archiveName}`;

  try {
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(extractPath, { recursive: true });
    await downloadFile(url, archivePath);
    const extract = await runCommand("tar", ["-xzf", archivePath, "-C", extractPath, "--strip-components", "1"], {
      timeoutMs: 120_000
    });
    if (extract.code !== 0) {
      return false;
    }
    await rm(runtimeRoot, { recursive: true, force: true });
    await mkdir(dirname(runtimeRoot), { recursive: true });
    await renameDirectory(extractPath, runtimeRoot);
    return existsSync(getManagedPythonExecutable(runtimeRoot));
  } catch {
    return false;
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function renameDirectory(from: string, to: string): Promise<void> {
  const { rename } = await import("node:fs/promises");
  await rename(from, to);
}

function getManagedPythonExecutable(runtimeRoot: string): string {
  return process.platform === "win32"
    ? join(runtimeRoot, "python.exe")
    : join(runtimeRoot, "bin", "python3");
}

function getPythonStandaloneArchiveName(): string | null {
  const archMap: Record<string, string> = {
    arm64: "aarch64",
    x64: "x86_64",
    ia32: "i686"
  };
  const platformMap: Record<string, string> = {
    darwin: "apple-darwin",
    linux: "unknown-linux-gnu",
    win32: "pc-windows-msvc"
  };
  const arch = archMap[process.arch] ?? process.arch;
  const platform = platformMap[process.platform];
  if (!platform) return null;
  return `cpython-${PYTHON_VERSION}+${PYTHON_BUILD_DATE}-${arch}-${platform}-install_only_stripped.tar.gz`;
}

const DOWNLOAD_TOTAL_TIMEOUT_MS = 120_000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;

/**
 * #548：原实现无任何超时、response 流无 error 监听（socket reset 即踩中
 * uncaughtException 五击止损）、重定向未销毁旧响应、失败残留半截文件。
 */
export async function downloadFile(
  url: string,
  destination: string,
  options: { totalTimeoutMs?: number; idleTimeoutMs?: number } = {}
): Promise<void> {
  const totalTimeoutMs = options.totalTimeoutMs ?? DOWNLOAD_TOTAL_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DOWNLOAD_IDLE_TIMEOUT_MS;
  await mkdir(dirname(destination), { recursive: true });
  try {
    await new Promise<void>((resolve, reject) => {
      let currentRequest: http.ClientRequest | null = null;
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const settleOk = () => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        clearIdleTimer();
        resolve();
      };
      const settleFail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        clearIdleTimer();
        currentRequest?.destroy();
        reject(error);
      };
      // 服务端停摆式下载会让 TEST_SEARCH_BACKEND RPC 永久悬挂，总时长兜底必配
      const totalTimer = setTimeout(
        () => settleFail(new Error(`下载失败，总时长超过 ${totalTimeoutMs}ms: ${url}`)),
        totalTimeoutMs
      );
      totalTimer.unref();

      // 自管空闲检测：Bun 下 request.setTimeout 在响应中期不触发（#548 核验），
      // 以 data 事件喂狗的定时器跨运行时可靠
      function clearIdleTimer(): void {
        if (idleTimer !== undefined) {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        }
      }
      const armIdleTimer = (target: string) => {
        clearIdleTimer();
        idleTimer = setTimeout(() => {
          settleFail(new Error(`下载失败，连接空闲超时: ${target}`));
          currentRequest?.destroy();
        }, idleTimeoutMs);
        idleTimer.unref();
      };

      const visit = (target: string, redirects: number) => {
        if (redirects > 10) {
          settleFail(new Error(`下载失败，重定向次数过多: ${url}`));
          return;
        }
        armIdleTimer(target);
        const client = target.startsWith("https:") ? https : http;
        const request = client.get(target, (response) => {
          // 全分支统一挂 error 监听：无监听的 error 事件会计入 uncaughtException 五击止损（#548）
          response.on("error", settleFail);
          const location = response.headers.location;
          if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && location) {
            response.resume(); // 排空旧响应以释放连接，随后换绑 currentRequest 到新目标
            visit(new URL(location, target).toString(), redirects + 1);
            return;
          }
          if (response.statusCode !== 200) {
            response.resume();
            settleFail(new Error(`下载失败，HTTP ${response.statusCode}: ${target}`));
            return;
          }
          response.on("data", () => armIdleTimer(target));
          const file = createWriteStream(destination);
          response.pipe(file);
          file.on("finish", () => file.close(() => settleOk()));
          file.on("error", settleFail);
        });
        currentRequest = request;
        request.on("error", settleFail);
      };
      visit(url, 0);
    });
  } catch (error) {
    await rm(destination, { force: true }).catch(() => {});
    throw error;
  }
}

function parseJson(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return 5;
  return Math.max(1, Math.min(Math.trunc(limit), 10));
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...(truncated)` : value;
}
