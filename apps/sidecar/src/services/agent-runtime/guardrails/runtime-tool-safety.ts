import { canonicalizeAgentToolName } from "@lume/shared";
import { analyzeBashCommand } from "@lume/agent-sdk";

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

export function evaluateRuntimeToolSafety(toolName: string, input: unknown): RuntimeToolSafetyDecision {
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

  for (const rule of HARD_DENY_BASH_RULES) {
    if (rule.pattern.test(command)) {
      return { behavior: "deny", reason: rule.reason };
    }
  }

  for (const rule of FORCE_CONFIRM_BASH_RULES) {
    if (rule.pattern.test(command)) {
      return { behavior: "confirm", reason: rule.reason };
    }
  }

  const analysis = analyzeBashCommand(command);
  if (analysis.status !== "simple") {
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
