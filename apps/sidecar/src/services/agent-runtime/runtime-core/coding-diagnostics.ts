import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * #573①:Edit/Write 成功后的单仓诊断回传——按项目内已安装的 checker 探测可用性,
 * 不发明命令、不全局装依赖。tsc 优先(类型错误是编码主痛),eslint 兜底。
 * 全程 deadline 熔断,大仓首跑超时不阻塞验证闭环。
 */

export type DiagnosticsChecker = "tsc" | "eslint";

export interface DiagnosticEntry {
  file: string;
  line: number;
  column?: number;
  code?: string;
  message: string;
}

export interface DiagnosticsOutcome {
  checker: DiagnosticsChecker;
  /** 已排序：编辑过的文件优先，其后其余；条目已截断 */
  entries: DiagnosticEntry[];
  totalErrors: number;
  timedOut: boolean;
}

export const DIAGNOSTIC_DEADLINE_MS = 30_000;
export const MAX_DIAGNOSTIC_ENTRIES = 10;
/** 可诊断的脚本扩展名(JS/TS 系;python/go/rust 走既有语言级验证命令通道) */
const DIAGNOSTIC_FILE_EXTENSIONS = /\.(m|c)?[jt]sx?$/i;
const ESLINT_CONFIG_NAMES = [
  ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.yaml", ".eslintrc.yml", ".eslintrc.json", ".eslintrc",
  "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs",
];

export function isDiagnosticEligibleFile(path: string): boolean {
  return DIAGNOSTIC_FILE_EXTENSIONS.test(path);
}

/** #573① review:官方 typescript 包编译器在 lib/tsc.js(bin/ 只有扩展名 shim),兼容两种布局 */
function resolveTscEntryPath(workspaceRoot: string): string | null {
  const libPath = join(workspaceRoot, "node_modules", "typescript", "lib", "tsc.js");
  if (existsSync(libPath)) return libPath;
  const binPath = join(workspaceRoot, "node_modules", "typescript", "bin", "tsc.js");
  if (existsSync(binPath)) return binPath;
  return null;
}

export function detectDiagnosticsChecker(workspaceRoot: string): DiagnosticsChecker | null {
  if (
    resolveTscEntryPath(workspaceRoot) !== null
    && existsSync(join(workspaceRoot, "tsconfig.json"))
  ) return "tsc";
  if (
    existsSync(join(workspaceRoot, "node_modules", "eslint", "bin", "eslint.js"))
    && ESLINT_CONFIG_NAMES.some((name) => existsSync(join(workspaceRoot, name)))
  ) return "eslint";
  return null;
}

/** `src/a.ts(12,34): error TS2345: message` */
export function parseTscOutput(stdout: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(.+?)\((\d+),(\d+)\):\s+error\s+([\w/]+):\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    entries.push({
      file: match[1]!.replace(/\\/g, "/"),
      line: Number(match[2]),
      column: Number(match[3]),
      code: match[4],
      message: match[5]!,
    });
  }
  return entries;
}

interface EslintJsonReport {
  filePath?: string;
  messages?: Array<{
    line?: number;
    column?: number;
    severity?: number;
    ruleId?: string | null;
    message?: string;
  }>;
}

/** eslint --format json 输出;只取 severity===2(error) */
export function parseEslintJson(stdout: string): DiagnosticEntry[] {
  let reports: EslintJsonReport[];
  try {
    reports = JSON.parse(stdout) as EslintJsonReport[];
  } catch {
    return [];
  }
  if (!Array.isArray(reports)) return [];
  const entries: DiagnosticEntry[] = [];
  for (const report of reports) {
    if (!Array.isArray(report.messages)) continue;
    const file = (report.filePath ?? "").replace(/\\/g, "/");
    for (const message of report.messages) {
      if (message.severity !== 2 || !message.message) continue;
      entries.push({
        file,
        line: typeof message.line === "number" ? message.line : 1,
        column: typeof message.column === "number" ? message.column : undefined,
        code: message.ruleId ?? undefined,
        message: message.message,
      });
    }
  }
  return entries;
}

function editedFileFirst(entries: DiagnosticEntry[], editedFiles: string[]): DiagnosticEntry[] {
  if (editedFiles.length === 0) return entries;
  const normalizedEdited = editedFiles.map((file) => file.replace(/\\/g, "/").toLowerCase());
  const isEdited = (entry: DiagnosticEntry) => {
    const normalized = entry.file.toLowerCase();
    return normalizedEdited.some((edited) => normalized.endsWith(edited) || edited.endsWith(normalized));
  };
  return [...entries.filter(isEdited), ...entries.filter((entry) => !isEdited(entry))];
}

function formatEntries(entries: DiagnosticEntry[]): string {
  return entries
    .map((entry) => `- ${entry.file}:${entry.line}${entry.column ? `:${entry.column}` : ""} ${entry.code ? `[${entry.code}] ` : ""}${entry.message}`)
    .join("\n")
    .slice(0, 2_000);
}

export function formatDiagnosticsMessage(outcome: DiagnosticsOutcome): string {
  const checkerLabel = outcome.checker === "tsc" ? "类型检查" : "eslint";
  const shownCount = outcome.entries.length;
  const more = outcome.totalErrors > shownCount ? `\n- … 其余 ${outcome.totalErrors - shownCount} 个错误未展开` : "";
  const timeoutNote = outcome.timedOut ? "\n- 注意：诊断在截止时间内被熔断，可能不完整。" : "";
  // #573① review:不断言因果——仓库存量错误也会被全仓 checker 报出,只声明「编辑文件优先」
  return `[diagnostics] ${checkerLabel}检测到 ${outcome.totalErrors} 个错误（编辑过的文件优先展示）：\n${formatEntries(outcome.entries)}${more}${timeoutNote}`;
}

function runProcess(
  commandPath: string,
  args: string[],
  cwd: string,
  deadlineMs: number,
): Promise<{ stdout: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    // #573① review:桌面端 sidecar 跑在 Electron utilityProcess 里,execPath 是 Electron
    // 可执行文件——必须置 RUN_AS_NODE 才会以 Node 模式执行 checker 脚本(仓内三处先例同款)
    const child = spawn(process.execPath, [commandPath, ...args], {
      cwd,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, deadlineMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      // 上限保护：超大输出不再累积（tsc 全量错误也可能很大）
      if (stdout.length < 1_000_000) stdout += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout, timedOut });
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ stdout, timedOut });
    });
  });
}

/**
 * 收集一次诊断。files 是编辑过的文件路径(相对或绝对);返回 null 表示无可用 checker。
 * tsc 是全仓检查——错误按「编辑过的文件优先」排序后截断。
 */
export async function collectDiagnostics(input: {
  workspaceRoot: string;
  files: string[];
  deadlineMs?: number;
}): Promise<DiagnosticsOutcome | null> {
  const deadlineMs = input.deadlineMs ?? DIAGNOSTIC_DEADLINE_MS;
  const checker = detectDiagnosticsChecker(input.workspaceRoot);
  if (!checker) return null;
  if (checker === "tsc") {
    // #573① review:--pretty false 覆盖 tsconfig 的 pretty 设置,保证机器可读单行格式
    const { stdout, timedOut } = await runProcess(
      resolveTscEntryPath(input.workspaceRoot)!,
      ["--noEmit", "--pretty", "false", "-p", "."],
      input.workspaceRoot,
      deadlineMs,
    );
    const all = parseTscOutput(stdout);
    const entries = editedFileFirst(all, input.files).slice(0, MAX_DIAGNOSTIC_ENTRIES);
    return { checker, entries, totalErrors: all.length, timedOut };
  }
  const eslintJs = join(input.workspaceRoot, "node_modules", "eslint", "bin", "eslint.js");
  // '--' 分隔防路径以 - 开头被当 flag
  const { stdout, timedOut } = await runProcess(eslintJs, ["--format", "json", "--", ...input.files], input.workspaceRoot, deadlineMs);
  const all = parseEslintJson(stdout);
  const entries = editedFileFirst(all, input.files).slice(0, MAX_DIAGNOSTIC_ENTRIES);
  return { checker, entries, totalErrors: all.length, timedOut };
}
