import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";

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

  async convertWithSoffice(inputPath: string, outputDir: string, targetExt: string): Promise<OfficeToolExecutorResult> {
    const outputPath = resolve(outputDir, `${this.baseName(inputPath)}.${targetExt}`);
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
    // SAL_USE_VCLPLUGIN=svp 强制无头 VCL 后端；原 socket shim 拦截路径从未生效
    // （探针 socket 全仓无创建者，sofficeNeedsShim 的 connect 探测总在结果前返回）
    // 且无 error 监听器会触发进程级未捕获异常，已整体删除
    return this.runCommand(this.resolveSoffice(), args, {
      ...options,
      env: { SAL_USE_VCLPLUGIN: "svp" }
    });
  }

  async runPython(args: string[], options: { timeoutMs: number; outputEncoding?: BufferEncoding; env?: Record<string, string | undefined> } = { timeoutMs: 20 * 60 * 1000, outputEncoding: "utf-8" }): Promise<OfficeToolExecutorResult> {
    const commands = ["python3", "python3.11", "python"];
    for (const command of commands) {
      try {
        const probe = await this.runCommand(command, ["--version"], {
          timeoutMs: Math.min(options.timeoutMs, 5_000),
          outputEncoding: options.outputEncoding
        });
        if (!probe.ok) continue;
        // import validators 会在源码树再生 __pycache__/.pyc，禁写字节码（默认在前，未来 options.env 优先）
        return await this.runCommand(command, args, {
          ...options,
          env: { PYTHONDONTWRITEBYTECODE: "1", ...options.env },
        });
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

