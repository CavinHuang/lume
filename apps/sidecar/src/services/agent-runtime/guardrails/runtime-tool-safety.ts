import { canonicalizeAgentToolName } from "@lume/shared";
import { analyzeBashCommand, isReadOnlyPowerShell, shellKindConservative } from "@lume/agent-sdk";
import {
  PS_CLEAR_CONTENT_VERBS,
  PS_CONFIRM_COMMAND,
  PS_DANGEROUS_DELETE_FLAGS,
  PS_DELETE_COMMAND,
  PS_DYNAMIC_EXEC_VERBS,
  PS_FORMAT_VERBS,
  PS_START_PROCESS_SHELL_SPAWN,
  PS_STOP_VERBS,
  hasPowerShellContentSignal
} from "../ps-dangerous-verbs";

export type RuntimeToolSafetyDecision =
  | { behavior: "allow" }
  | { behavior: "confirm"; reason: string }
  | { behavior: "deny"; reason: string };

interface CommandRule {
  pattern: RegExp;
  reason: string;
}

/** rm 递归标志：短选项簇含 r/R（-r/-rf/-fr），或 GNU 长选项 */
const RM_RECURSIVE_FLAG = String.raw`(?:-[^\s]*[rR][^\s]*|--recursive|--recurse)`;
/** rm 选项区：零到多个选项 token（短簇/长选项/-- 分隔符），空白分隔 */
const RM_OPTIONS = String.raw`(?:(?:-{1,2}[^\s]+)\s+)*`;

const HARD_DENY_BASH_RULES: CommandRule[] = [
  { pattern: new RegExp(String.raw`\brm\s+${RM_OPTIONS}${RM_RECURSIVE_FLAG}\s+${RM_OPTIONS}\/(?:\s|$|[;&|])`), reason: "禁止删除根目录" },
  { pattern: new RegExp(String.raw`\brm\s+${RM_OPTIONS}${RM_RECURSIVE_FLAG}\s+${RM_OPTIONS}(?:~|\$HOME)(?:\s|$|[;&|])`), reason: "禁止删除用户主目录" },
  { pattern: /:\s*\(\s*\)\s*\{.*\}\s*;.*:/, reason: "禁止 fork bomb" },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: "禁止写入块设备" }
];

const FORCE_CONFIRM_BASH_RULES: CommandRule[] = [
  { pattern: /\bgit\s+commit\b/, reason: "git commit 会写入仓库历史，需要用户确认" },
  { pattern: /\bgit\s+push\b/, reason: "git push 会向外部远端发布内容，需要用户确认" },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: "git reset --hard 会丢弃本地改动，需要用户确认" },
  { pattern: /\bgit\s+clean\s+-[^\s]*[fd][^\s]*\b/, reason: "git clean 会删除未跟踪文件，需要用户确认" },
  { pattern: new RegExp(String.raw`\brm\s+${RM_OPTIONS}${RM_RECURSIVE_FLAG}\s+${RM_OPTIONS}["']?[^/\s][^;&|]*["']?(?:\s|$|[;&|])`), reason: "递归强制删除文件需要用户确认" },
  { pattern: /\b(?:curl|wget)\b[\s\S]*\|\s*(?:sh|bash)\b/, reason: "远程脚本管道执行需要用户确认" },
  { pattern: /\b(?:open|xdg-open|start)\s+https?:\/\//, reason: "打开外部 URL 需要用户确认" }
];

/*
 * PowerShell 破坏性动词词表：Windows 无 POSIX bash 时回退 powershell.exe，
 * 不带显式前缀的 PS 命令会被 bash 语法树判为 simple，绕过下方结构化规则与启发式分类器，
 * 因此在正则层按原始文本先行识别。动词集合与分类器共享（../ps-dangerous-verbs）。
 * 良性 Get-* / Format-Table 等命令不受影响。
 */

const HARD_DENY_TARGETS = String.raw`(?:[a-z]:[\\/]*|[\\/]+|~|\$home|\$env:userprofile|\$\{env:userprofile\})`;

const HARD_DENY_POWERSHELL_RULES: CommandRule[] = [
  {
    // 删除族指向盘符根/根路径/用户主目录裸目标；不带递归标志也拒，比 bash 侧更严。
    // 双支结构：裸/单层引号形态共享前瞻（边界后不得再接路径，防 ($home)\Documents 子路径
    // 被过度硬拒）；括号支容忍多层配对括号与内层引号（("～")、(($home)) 复合形态同属
    // 删除意图）且闭合后即边界。完整 UNC 根（\\server\share）不在目标命中面内。
    // 填充区不含换行，防跨行吞并下一行的良性参数
    pattern: new RegExp(String.raw`${PS_DELETE_COMMAND}[^\r\n;&|]*[^\S\r\n](?:[(["']?${HARD_DENY_TARGETS}["')]?(?=\s|$|[;&|])|\(+\s*["']?${HARD_DENY_TARGETS}["']?\s*\)+(?=\s|$|[;&|]))`, "i"),
    reason: "禁止删除根目录或用户主目录"
  }
];

const FORCE_CONFIRM_POWERSHELL_RULES: CommandRule[] = [
  {
    // 仅危险标志簇触发确认；命名参数(-Path/-LiteralPath 等)与 -WhatIf 干跑旗标不再触发，
    // 保持「裸路径单文件删除不升级」口径。锚点与删除族同源（含 cmd 包裹内层），
    // 防止包裹识别只覆盖删除族的单侧组合缺口
    pattern: new RegExp(String.raw`${PS_DELETE_COMMAND}[^\r\n;&|]*[^\S\r\n]${PS_DANGEROUS_DELETE_FLAGS}`, "i"),
    reason: "递归强制删除文件需要用户确认"
  },
  { pattern: new RegExp(`${PS_CONFIRM_COMMAND}${PS_STOP_VERBS}\\b`, "i"), reason: "停止进程、服务或重启系统需要用户确认" },
  { pattern: new RegExp(`${PS_CONFIRM_COMMAND}${PS_DYNAMIC_EXEC_VERBS}\\b`, "i"), reason: "修改脚本执行策略或动态执行代码需要用户确认" },
  { pattern: new RegExp(`${PS_CONFIRM_COMMAND}${PS_FORMAT_VERBS}\\b`, "i"), reason: "格式化磁盘或卷需要用户确认" },
  { pattern: new RegExp(`${PS_CONFIRM_COMMAND}${PS_CLEAR_CONTENT_VERBS}\\b`, "i"), reason: "清空文件内容需要用户确认" },
  {
    // #713 review：Start-Process 参数列表间接拉起 shell 的确认档（包裹锚两头失配
    // 的旁路收口，探针与锚点同源钉死）
    pattern: new RegExp(PS_START_PROCESS_SHELL_SPAWN, "i"),
    reason: "Start-Process 拉起 shell 子进程需要用户确认"
  }
];

const FORCE_CONFIRM_TOOLS = new Map<string, string>([
  ["memory.promoteglobal", "提升到全局记忆会影响跨工作区记忆，需要用户确认"],
  ["memory.rejectglobalcandidate", "拒绝全局记忆候选会影响跨工作区记忆，需要用户确认"],
  ["automation_set", "修改自动化任务会影响未来定时执行，需要用户确认"],
  ["cron_set", "修改自动化任务会影响未来定时执行，需要用户确认"]
]);

function getCommand(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  const command = record.command ?? record.cmd;
  return typeof command === "string" ? command : "";
}

export interface RuntimeToolSafetyContext {
  /** 测试注入口；缺省按真实进程平台与环境解析 */
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export function evaluateRuntimeToolSafety(toolName: string, input: unknown, context: RuntimeToolSafetyContext = {}): RuntimeToolSafetyDecision {
  const normalized = canonicalizeAgentToolName(toolName);
  const forceConfirmReason = FORCE_CONFIRM_TOOLS.get(normalized);
  if (forceConfirmReason) {
    return { behavior: "confirm", reason: forceConfirmReason };
  }

  if (normalized !== "bash") {
    return { behavior: "allow" };
  }

  const command = getCommand(input);
  if (!command.trim()) {
    return { behavior: "allow" };
  }

  /*
   * PS 词表激活判定（#707 两通道）：其一为方言——实际以 PowerShell 为执行 shell 的环境。
   * POSIX bash 在场时命令是 bash 语法，模型不会发 PS 动词，而 iex/ri 等真实 POSIX 命令与
   * PS 撞名，全平台跑词表会把 Elixir/Ruby 日常命令翻成强审批且「始终允许」豁免不掉。探测
   * 复用 packages/sdk 的 shell 解析顺序且不触发 Windows bash 发现；与 #471 只读判定的差异
   * 在冷启动方向——bash 发现未决时按保守侧读作 powershell（fail-closed），否则无 bash 机器
   * 生命周期首条命令必然跳过词表，恰是本层要防的场景。其二为内容信号（win32 限定）——装
   * POSIX bash 的 Windows 机上方言读作 bash，词表整层休眠，Remove-Item -Recurse -Force 一类
   * 命令漏判；文本自身呈强 PS 形态时无视方言激活（信号形态刻意排除 iex/ri 撞名，见
   * ps-dangerous-verbs）。非 win32 宿主不消费信号：Linux/macOS 上 PS 命令必然 command-not-found，
   * 且跨平台套用会翻转已钉住的精确 bash 读法。
   */
  const platform = context.platform ?? process.platform;
  const powershellDialect = shellKindConservative(platform, context.env ?? process.env) === "powershell";
  // 内容信号只升确认档（#707）：issue 场景的危害是「判 low 静默放行」，确认层即可兜住；
  // hard-deny 层与 parse-unavailable 放行通道仍由真实方言独占——显式配置 bash 的机器
  // 回精确读法（不硬拒）的既定语义不被文本信号翻转
  const powershellConfirmActive =
    powershellDialect || (platform === "win32" && hasPowerShellContentSignal(command));

  for (const rule of [...HARD_DENY_BASH_RULES, ...(powershellDialect ? HARD_DENY_POWERSHELL_RULES : [])]) {
    if (rule.pattern.test(command)) {
      return { behavior: "deny", reason: rule.reason };
    }
  }

  for (const rule of [...FORCE_CONFIRM_BASH_RULES, ...(powershellConfirmActive ? FORCE_CONFIRM_POWERSHELL_RULES : [])]) {
    if (rule.pattern.test(command)) {
      return { behavior: "confirm", reason: rule.reason };
    }
  }

  const analysis = analyzeBashCommand(command);
  if (analysis.status !== "simple") {
    /*
     * PS 方言收口（#571 第 3 项）：PowerShell 命令（显式前缀或 PS 默认 shell 的机器）
     * 无法被 bash 语法树解析，此前一律 confirm 且该 confirm 不持久化——即使同一命令
     * 已「始终允许」，这里也会把它翻回审批（gateway 合并语义），构成 Windows 上的
     * 恒久双闸。现改为：保守只读子集内的命令放行（内容证明，与引擎免审通道同源），
     * 其余不可解析形态维持 fail-closed 确认。非 PS 方言路径不变。
     */
    const psDialect =
      powershellDialect ||
      /^\s*(?:powershell|pwsh)(?:\.exe)?(?:\s|$)/i.test(command);
    if (psDialect && isReadOnlyPowerShell(command)) {
      return { behavior: "allow" };
    }
    return { behavior: "confirm", reason: "命令包含无法安全解析的 Shell 或 PowerShell 语法，需要一次性确认" };
  }

  const destructive = evaluateStructuredBashSafety(analysis);
  if (destructive) return destructive;

  return { behavior: "allow" };
}

/** rm 递归标志：短选项簇含 r/R，或 GNU 长选项（与正则层规则保持同一判定口径） */
function isRecursiveRmFlag(arg: string): boolean {
  return /^-(?!-)[^\s]*[rR]/.test(arg) || arg === "--recursive" || arg === "--recurse";
}

function evaluateStructuredBashSafety(analysis: ReturnType<typeof analyzeBashCommand>): RuntimeToolSafetyDecision | undefined {
  for (const segment of analysis.commands) {
    const [executable, ...args] = segment.argv;
    if (segment.executable === "rm" && args.some(isRecursiveRmFlag)) {
      const targets = args.filter((arg) => !arg.startsWith("-"));
      if (targets.some((target) => target === "/" || target === "~" || target === "$HOME")) {
        return { behavior: "deny", reason: "禁止递归删除根目录或用户主目录" };
      }
      return { behavior: "confirm", reason: "递归删除文件需要用户确认" };
    }
    if (["sudo", "doas", "pkexec", "runas"].includes(segment.executable)) {
      return { behavior: "confirm", reason: "提权命令需要用户确认" };
    }
    if (segment.executable === "git") {
      if (args.includes("commit") || args.includes("push")) {
        return { behavior: "confirm", reason: `git ${args.includes("push") ? "push" : "commit"} 会修改或发布仓库历史，需要用户确认` };
      }
      if (
        (args.includes("reset") && args.includes("--hard")) ||
        (args.includes("clean") && args.some((arg) => /^-[^-]*[fd]/.test(arg))) ||
        args.includes("rebase") || args.includes("filter-repo")
      ) {
        return { behavior: "confirm", reason: "git 历史改写或文件清理需要用户确认" };
      }
    }
    if (executable === "dd" && args.some((arg) => /^of=\/dev\/(?:sd|disk|nvme)/.test(arg))) {
      return { behavior: "deny", reason: "禁止写入块设备" };
    }
  }
  if (analysis.hasPipeline && analysis.commands.some((segment) => ["curl", "wget"].includes(segment.executable)) && analysis.commands.some((segment) => ["sh", "bash", "zsh"].includes(segment.executable))) {
    return { behavior: "confirm", reason: "远程脚本管道执行需要用户确认" };
  }
  if (analysis.hasRedirection) {
    return { behavior: "confirm", reason: "命令包含输出重定向，需要用户确认" };
  }
  return undefined;
}
