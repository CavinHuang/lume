import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { tmpdir } from "node:os";
import { Socket } from "node:net";

export type RuntimeMode = "js" | "python" | "soffice";

export interface OfficeToolExecutionContext {
  cwd: string;
}

export interface OfficeToolExecutorResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  timedOut?: boolean;
}

export class OfficeToolExecutor {
  private readonly scriptsRoot: string;

  constructor(private readonly workdir: string) {
    this.scriptsRoot = resolveScriptsRoot();
  }

  async runPythonScript(script: string, args: string[] = []): Promise<OfficeToolExecutorResult> {
    const scriptPath = resolve(this.scriptsRoot, script);
    return this.runPython([scriptPath, ...args], { timeoutMs: 20 * 60 * 1000 });
  }

  async runJsScript(script: string, args: string[] = []): Promise<OfficeToolExecutorResult> {
    const scriptPath = resolve(this.scriptsRoot, script);
    return this.runCommand("node", [scriptPath, ...args], {
      timeoutMs: 20 * 60 * 1000,
      outputEncoding: "utf-8",
    });
  }

  async executeJs(code: string, outputPath: string): Promise<OfficeToolExecutorResult> {
    const scriptPath = resolve(this.workdir, `.lume-office-js-${Date.now()}.mjs`);
    mkdirSync(dirname(scriptPath), { recursive: true });
    const safeOutputPath = JSON.stringify(outputPath);
    const payload = `
const outputPath = ${safeOutputPath};
${code}
`;
    writeFileSync(scriptPath, payload, "utf-8");
    try {
      return await this.runCommand("node", [scriptPath], {
        timeoutMs: 10 * 60 * 1000,
        outputEncoding: "utf-8"
      });
    } finally {
      try {
        if (existsSync(scriptPath)) {
          const stat = statSync(scriptPath);
          if (stat.size > 0) {
            writeFileSync(scriptPath, "", "utf-8");
          }
        }
      } catch {
        // best-effort cleanup
      }
    }
  }

  async executePython(script: string, args: string[] = []): Promise<OfficeToolExecutorResult> {
    const scriptPath = resolve(this.workdir, `.lume-office-py-${Date.now()}.py`);
    mkdirSync(dirname(scriptPath), { recursive: true });
    writeFileSync(scriptPath, script, "utf-8");
    try {
      return await this.runPython([scriptPath, ...args], {
        timeoutMs: 20 * 60 * 1000,
        outputEncoding: "utf-8"
      });
    } finally {
      try {
        if (existsSync(scriptPath)) {
          const stat = statSync(scriptPath);
          if (stat.size > 0) {
            writeFileSync(scriptPath, "", "utf-8");
          }
        }
      } catch {
        // best-effort cleanup
      }
    }
  }

  /** soffice 产物路径：输入名剥最后一段扩展名 + 目标扩展名（report.v2.docx → report.v2.pdf）。 */
  convertOutputPath(inputPath: string, outputDir: string, targetExt: string): string {
    return resolve(outputDir, `${this.baseName(inputPath)}.${targetExt}`);
  }

  async convertWithSoffice(inputPath: string, outputDir: string, targetExt: string): Promise<OfficeToolExecutorResult> {
    const outputPath = this.convertOutputPath(inputPath, outputDir, targetExt);
    const result = await this.runSoffice([
      "--headless",
      "--convert-to",
      targetExt,
      "--outdir",
      outputDir,
      inputPath
    ], { timeoutMs: 20 * 60 * 1000, outputEncoding: "utf-8" });
    if (!existsSync(outputPath)) {
      return { ...result, ok: false, stderr: `${result.stderr ?? ""}\nMissing output: ${outputPath}` };
    }
    return { ...result, ok: true };
  }

  async runSoffice(args: string[], options: { timeoutMs: number; outputEncoding?: BufferEncoding } = { timeoutMs: 20 * 60 * 1000, outputEncoding: "utf-8" }): Promise<OfficeToolExecutorResult> {
    const env = await this.getSofficeEnv();
    return this.runCommand(this.resolveSoffice(), args, {
      ...options,
      env
    });
  }

  async runPython(args: string[], options: { timeoutMs: number; outputEncoding?: BufferEncoding } = { timeoutMs: 20 * 60 * 1000, outputEncoding: "utf-8" }): Promise<OfficeToolExecutorResult> {
    const commands = ["python3", "python3.11", "python"];
    for (const command of commands) {
      try {
        const probe = await this.runCommand(command, ["--version"], {
          timeoutMs: Math.min(options.timeoutMs, 5_000),
          outputEncoding: options.outputEncoding
        });
        if (!probe.ok) continue;
        return await this.runCommand(command, args, options);
      } catch {
        // try next python candidate
      }
    }
    return {
      ok: false,
      exitCode: 127,
      stderr: "Python runtime not found"
    };
  }

  async runCommand(command: string, args: string[], options: { timeoutMs: number; outputEncoding?: BufferEncoding; env?: Record<string, string | undefined> } = { timeoutMs: 10 * 60 * 1000, outputEncoding: "utf-8" }): Promise<OfficeToolExecutorResult> {
    const outputEncoding = options.outputEncoding ?? "utf-8";
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: this.workdir, env: options.env ? { ...process.env, ...options.env } : undefined });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdoutChunks.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk) => {
        stderrChunks.push(Buffer.from(chunk));
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.on("close", (exitCode) => {
        clearTimeout(timer);
        stdout = Buffer.concat(stdoutChunks).toString(outputEncoding);
        stderr = Buffer.concat(stderrChunks).toString(outputEncoding);
        resolve({
          ok: (exitCode ?? 1) === 0,
          stdout,
          stderr,
          exitCode: exitCode ?? 1,
          timedOut
        });
      });
    });
  }

  private resolveSoffice(): string {
    const candidates = [
      "/Applications/LibreOffice.app/Contents/MacOS/soffice",
      "/usr/bin/soffice",
      "soffice"
    ];
    for (const candidate of candidates) {
      if (this.commandExists(candidate)) {
        return candidate;
      }
    }
    return "soffice";
  }

  private async getSofficeEnv(): Promise<Record<string, string | undefined>> {
    const env: Record<string, string | undefined> = { SAL_USE_VCLPLUGIN: "svp" };
    if (this.sofficeNeedsShim()) {
      env.LD_PRELOAD = await this.ensureSofficeShim();
    }
    return env;
  }

  private sofficeNeedsShim(): boolean {
    try {
      const socket = new Socket();
      socket.connect({ path: "/tmp/.lo_socket_shim_probe" });
      socket.end();
      return false;
    } catch {
      return true;
    }
  }

  private async ensureSofficeShim(): Promise<string> {
    const shimPath = resolve(tmpdir(), "lo_socket_shim.so");
    if (existsSync(shimPath)) {
      return shimPath;
    }

    const sourcePath = resolve(tmpdir(), "lo_socket_shim.c");
    writeFileSync(sourcePath, SOFFICE_SHIM_SOURCE, "utf-8");
    const compileResult = await this.runCommand("gcc", [
      "-shared",
      "-fPIC",
      "-o", shimPath,
      sourcePath,
      "-ldl"
    ], { timeoutMs: 2 * 60 * 1000, outputEncoding: "utf-8" });
    if (!compileResult.ok) {
      throw new Error(`LibreOffice socket shim build failed: ${compileResult.stderr ?? compileResult.stdout}`);
    }
    try {
      if (existsSync(sourcePath)) {
        statSync(sourcePath);
      }
    } catch {
      // leave source file on disk for debugging
    }
    return shimPath;
  }

  private commandExists(command: string): boolean {
    try {
      if (command.includes(sep) && existsSync(command) && !statSync(command).isDirectory()) {
        return true;
      }
    } catch {
      // fallback to path lookup
    }
    try {
      const result = require("child_process").execSync(`command -v ${JSON.stringify(command)}`, { encoding: "utf-8" });
      return Boolean(result.trim());
    } catch {
      return false;
    }
  }

  private baseName(filePath: string): string {
    const name = dirname(filePath) ? resolve(filePath).split(sep).pop() ?? filePath : filePath;
    const withoutExt = name.replace(/\.[^.]+$/, "");
    return withoutExt || name;
  }
}

function resolveScriptsRoot(): string {
  const __dirname = fileURLToPath(new URL(".", import.meta.url));
  return resolve(__dirname, "scripts");
}

const SOFFICE_SHIM_SOURCE = `
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <unistd.h>

static int (*real_socket)(int, int, int);
static int (*real_socketpair)(int, int, int, int[2]);
static int (*real_listen)(int, int);
static int (*real_accept)(int, struct sockaddr *, socklen_t *);
static int (*real_close)(int);
static int (*real_read)(int, void *, size_t);

static int is_shimmed[1024];
static int peer_of[1024];
static int wake_r[1024];
static int wake_w[1024];
static int listener_fd = -1;

__attribute__((constructor))
static void init(void) {
    real_socket     = dlsym(RTLD_NEXT, "socket");
    real_socketpair = dlsym(RTLD_NEXT, "socketpair");
    real_listen     = dlsym(RTLD_NEXT, "listen");
    real_accept     = dlsym(RTLD_NEXT, "accept");
    real_close      = dlsym(RTLD_NEXT, "close");
    real_read       = dlsym(RTLD_NEXT, "read");
    for (int i = 0; i < 1024; i++) {
        peer_of[i] = -1;
        wake_r[i]  = -1;
        wake_w[i]  = -1;
    }
}

int socket(int domain, int type, int protocol) {
    if (domain == AF_UNIX) {
        int fd = real_socket(domain, type, protocol);
        if (fd >= 0) return fd;
        {
            int sv[2];
            if (real_socketpair(domain, type, protocol, sv) == 0) {
                if (sv[0] >= 0 && sv[0] < 1024) {
                    is_shimmed[sv[0]] = 1;
                    peer_of[sv[0]]    = sv[1];
                    int wp[2];
                    if (pipe(wp) == 0) {
                        wake_r[sv[0]] = wp[0];
                        wake_w[sv[0]] = wp[1];
                    }
                }
                return sv[0];
            }
        }
    }
    return real_socket(domain, type, protocol);
}

int socketpair(int domain, int type, int protocol, int sv[2]) {
    int rc = real_socketpair(domain, type, protocol, sv);
    if (rc != 0) return rc;
    if (domain == AF_UNIX && sv[0] >= 0 && sv[0] < 1024) {
        is_shimmed[sv[0]] = 1;
        peer_of[sv[0]]    = sv[1];
        int wp[2];
        if (pipe(wp) == 0) {
            wake_r[sv[0]] = wp[0];
            wake_w[sv[1]] = wp[1];
        }
    }
    return rc;
}

int listen(int sockfd, int backlog) {
    if (sockfd < 0 || sockfd >= 1024 || !is_shimmed[sockfd]) {
        return real_listen(sockfd, backlog);
    }
    listener_fd = sockfd;
    return 0;
}

int accept(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
    if (sockfd < 0 || sockfd >= 1024 || !is_shimmed[sockfd]) {
        return real_accept(sockfd, addr, addrlen);
    }
    int peer = peer_of[sockfd];
    if (peer < 0) {
        errno = EINVAL;
        return -1;
    }
    peer_of[sockfd] = -1;
    if (wake_r[sockfd] >= 0) {
        char buf[1];
        ssize_t n;
        while ((n = real_read(wake_r[sockfd], buf, 1)) < 0 && errno == EINTR);
        close(wake_r[sockfd]);
        wake_r[sockfd] = -1;
    }
    if (wake_w[peer] >= 0) {
        const char msg = 0;
        write(wake_w[peer], &msg, 1);
        wake_w[peer] = -1;
    }
    return peer;
}

int close(int fd) {
    if (fd < 0 || fd >= 1024 || !is_shimmed[fd]) {
        return real_close(fd);
    }
    if (listener_fd == fd) {
        listener_fd = -1;
    }
    int peer = peer_of[fd];
    if (peer >= 0) {
        peer_of[fd] = -1;
        if (wake_r[fd] >= 0) {
            char buf[1];
            ssize_t n;
            while ((n = read(wake_r[fd], buf, 1)) < 0 && errno == EINTR);
            close(wake_r[fd]);
            wake_r[fd] = -1;
        }
        if (wake_w[peer] >= 0) {
            const char msg = 0;
            write(wake_w[peer], &msg, 1);
            wake_w[peer] = -1;
        }
    }
    is_shimmed[fd] = 0;
    return 0;
}

ssize_t read(int fd, void *buf, size_t count) {
    if (fd < 0 || fd >= 1024 || !is_shimmed[fd]) {
        return real_read(fd, buf, count);
    }
    errno = EIO;
    return -1;
}
`;
