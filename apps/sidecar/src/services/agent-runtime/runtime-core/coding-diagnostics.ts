import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * #573①:Edit/Write 成功后的单仓诊断回传——按项目内已安装的 checker 探测可用性,
 * 不发明命令、不全局装依赖。tsc 优先(类型错误是编码主痛),eslint 兜底。
 * 全程 deadline 熔断,大仓首跑超时不阻塞验证闭环。
 *
 * 信任边界(#573 十视角 review·威胁建模):checker 的错误文案完全由仓库内容控制,
 * 会以 [diagnostics] 帧进入模型上下文——按不可信数据处理(控制字符剥离、长度预算),
 * 且交集执法保证只有触及本次编辑文件的错误才触发回注。spawn 项目内 checker 属
 * 「隐式执行仓库代码」,授权对齐(tsc/eslint 首跑审批)为已知 follow-up。
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
  /** checker 进程异常退出且解析不出任何条目——「坏了」而非「干净」，供上层告警 */
  degraded?: boolean;
  /** 异常退出时 stderr 尾部（截断），供排障 */
  stderrTail?: string;
}

export const DIAGNOSTIC_DEADLINE_MS = 30_000;
export const MAX_DIAGNOSTIC_ENTRIES = 10;
/** 可诊断的脚本扩展名(JS/TS 系;python/go/rust 走既有语言级验证命令通道) */
const DIAGNOSTIC_FILE_EXTENSIONS = /\.(m|c)?[jt]sx?$/i;
const ESLINT_CONFIG_NAMES = [
  ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.yaml", ".eslintrc.yml", ".eslintrc.json", ".eslintrc",
  "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs",
];
/** 单条消息的控制字符剥离(威胁建模:仓库受控文本不得携带终端/帧控制序列) */
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

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

/** `src/a.ts(12,34): error TS2345: message`(--pretty false 下单行稳定格式) */
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

/**
 * 「错误是否落在编辑文件内」的唯一判定（gate 回注执法与 editedFileFirst 排序共用，
 * 两处语义必须恒等——维护性 review F5）。
 */
export function isDiagnosticEntryRelevant(entry: DiagnosticEntry, editedFiles: string[]): boolean {
  if (editedFiles.length === 0) return true;
  const normalized = entry.file.toLowerCase();
  return editedFiles.some((edited) => {
    const normalizedEdited = edited.replace(/\\/g, "/").toLowerCase();
    return normalized.endsWith(normalizedEdited) || normalizedEdited.endsWith(normalized);
  });
}

function editedFileFirst(entries: DiagnosticEntry[], editedFiles: string[]): DiagnosticEntry[] {
  if (editedFiles.length === 0) return entries;
  return [
    ...entries.filter((entry) => isDiagnosticEntryRelevant(entry, editedFiles)),
    ...entries.filter((entry) => !isDiagnosticEntryRelevant(entry, editedFiles)),
  ];
}

const CHECKER_LABELS: Record<DiagnosticsChecker, string> = { tsc: "类型检查", eslint: "ESLint" };

function formatEntries(entries: DiagnosticEntry[]): string {
  // 逐条累加预算：放不下整条就停并显式标记，不拦腰截断半句（文案 review F3）
  let budget = 2_000;
  const lines: string[] = [];
  for (const entry of entries) {
    const cleaned = entry.message.replace(CONTROL_CHARS, "");
    const line = `- ${entry.file}:${entry.line}${entry.column ? `:${entry.column}` : ""} ${entry.code ? `[${entry.code}] ` : ""}${cleaned}`;
    if (line.length > budget) {
      lines.push("- …（清单因长度截断）");
      break;
    }
    budget -= line.length;
    lines.push(line);
  }
  return lines.join("\n");
}

export function formatDiagnosticsMessage(outcome: DiagnosticsOutcome): string {
  const shownCount = outcome.entries.length;
  const more = outcome.totalErrors > shownCount ? `\n- … 其余 ${outcome.totalErrors - shownCount} 个错误未展开` : "";
  const timeoutNote = outcome.timedOut ? "\n- 注意：诊断在截止时间内被熔断，可能不完整。" : "";
  // 不断言因果——全仓 checker 也会报出存量错误，只声明「编辑文件优先」排序
  return `[diagnostics] ${CHECKER_LABELS[outcome.checker]}发现 ${outcome.totalErrors} 个错误（编辑过的文件优先展示）：\n${formatEntries(outcome.entries)}${more}${timeoutNote}`;
}

interface ProcessResult {
  stdout: string;
  stderrTail: string;
  exitCode: number | null;
  timedOut: boolean;
}

function runProcess(
  commandPath: string,
  args: string[],
  cwd: string,
  deadlineMs: number,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    // 桌面端 sidecar 跑在 Electron utilityProcess 里,execPath 是 Electron 可执行文件——
    // 必须置 ELECTRON_RUN_AS_NODE 才会以 Node 模式执行 checker 脚本(仓内三处先例同款)
    const child = spawn(process.execPath, [commandPath, ...args], {
      cwd,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    let stdout = "";
    let stderrTail = "";
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      child.kill();
      // POSIX 兜底：SIGTERM 若被忽略则 3s 后 SIGKILL，防 completionGuard 悬挂
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }, 3_000);
    }, deadlineMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      // 上限保护：超大输出不再累积（tsc 全量错误也可能很大）
      if (stdout.length < 1_000_000) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      // 只留尾部用于排障（checker fatal 信息走 stderr，#573 可观测性 review F4）
      if (stderrTail.length < 4_000) stderrTail += chunk.toString("utf8");
      else stderrTail = stderrTail.slice(-2_000) + chunk.toString("utf8").slice(-2_000);
    });
    child.on("error", () => {
      clearTimeout(deadlineTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ stdout, stderrTail, exitCode: null, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(deadlineTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ stdout, stderrTail, exitCode: code, timedOut });
    });
  });
}

/**
 * 收集一次诊断。files 是编辑过的文件路径(相对或绝对);返回 null 表示无可用 checker。
 * tsc 是全仓检查——错误按「编辑过的文件优先」排序后截断。
 * 不变量：commandPath 必须是 checker 直连入口（lib/tsc.js、bin/eslint.js），
 * 不得换成 npm script/shim 包装——那会 fork 子进程树，deadline kill 杀不尽。
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
    // --pretty false 覆盖 tsconfig 的 pretty 设置,保证机器可读单行格式
    const processResult = await runProcess(
      resolveTscEntryPath(input.workspaceRoot)!,
      ["--noEmit", "--pretty", "false", "-p", "."],
      input.workspaceRoot,
      deadlineMs,
    );
    const all = parseTscOutput(processResult.stdout);
    const entries = editedFileFirst(all, input.files).slice(0, MAX_DIAGNOSTIC_ENTRIES);
    return withHealth(entries, all.length, checker, processResult);
  }
  const eslintJs = join(input.workspaceRoot, "node_modules", "eslint", "bin", "eslint.js");
  // '--' 分隔防路径以 - 开头被当 flag
  const processResult = await runProcess(eslintJs, ["--format", "json", "--", ...input.files], input.workspaceRoot, deadlineMs);
  const all = parseEslintJson(processResult.stdout);
  const entries = editedFileFirst(all, input.files).slice(0, MAX_DIAGNOSTIC_ENTRIES);
  return withHealth(entries, all.length, checker, processResult);
}

/** checker 异常退出却解析不出任何条目 = 环境故障伪装成「零错误」，打上降级标记 */
function withHealth(
  entries: DiagnosticEntry[],
  totalErrors: number,
  checker: DiagnosticsChecker,
  processResult: ProcessResult,
): DiagnosticsOutcome {
  return {
    checker,
    entries,
    totalErrors,
    timedOut: processResult.timedOut,
    ...(processResult.exitCode !== null && processResult.exitCode !== 0 && totalErrors === 0
      ? { degraded: true, stderrTail: processResult.stderrTail.slice(-500) }
      : {}),
  };
}
