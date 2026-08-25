import { shellKindConservative } from "@lume/agent-sdk";
import { PS_DELETE_COMMAND, PS_FULL_NAME_VERBS } from "../ps-dangerous-verbs";
import type {
  PermissionClassification,
  PermissionClassifierInput
} from "./permission-types";

const CRITICAL_PATTERNS = [
  /rm\s+(-rf?|--recursive)\s/i,
  /sudo\s/i,
  /chmod\s+[0-7]{3,4}\s/i,
  />\s*\/etc\//i,
  /mkfs\./i,
  /dd\s+if=/i,
  /kill\s+-9/i,
  /shutdown|reboot|halt/i,
  /curl\s.*\|\s*(bash|sh|zsh)/i,
  /npm\s+(publish|unpublish)/i,
  /git\s+push\s+.*--force/i,
  /DROP\s+(TABLE|DATABASE)/i,
  /DELETE\s+FROM\s+\w+\s*;?\s*$/i,
  /TRUNCATE\s/i
];

const MEDIUM_PATTERNS = [
  />\s/,
  /tee\s/,
  /mv\s/,
  /cp\s/,
  /mkdir\s/,
  /touch\s/,
  /echo\s.*>>/,
  /npm\s+install/i,
  /pip\s+install/i,
  /git\s+(commit|merge|rebase|checkout)/i,
  /(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|update|upgrade|link|exec)/i,
  /(?:npx|pnpx|yarn\s+dlx|bunx|corepack)\b/i,
  /(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)/i
];

// PowerShell 破坏性动词：Windows 无 bash 回退时与上方 POSIX 词表同档兜底，避免删除/停服等被判 low；
// 词表与 guardrail 正则层共享（../ps-dangerous-verbs），仅在实际以 PowerShell 为执行 shell 的环境套用
// （POSIX bash 在场时 iex/ri 等撞名命令防误拦）
const POWERSHELL_MEDIUM_PATTERNS = [
  new RegExp(String.raw`\b${PS_FULL_NAME_VERBS}\b`, "i"),
  new RegExp(PS_DELETE_COMMAND, "i")
];

export interface PermissionClassifier {
  classify(input: PermissionClassifierInput): Promise<PermissionClassification>;
}

/**
 * 分类器工厂：纯启发式规则分类（无 LLM 兜底层——投机 LLM 链已删）。
 * config 的 permissions.classifier.enabled 只门控本启发式分类器是否参与决策。
 */
export function createPermissionClassifier(): PermissionClassifier {
  return {
    async classify(input) {
      return classifyHeuristic(input);
    }
  };
}

export function classifyHeuristic(input: PermissionClassifierInput): PermissionClassification {
  const value = input.command ?? input.path ?? "";
  for (const pattern of CRITICAL_PATTERNS) {
    if (pattern.test(value)) {
      return {
        riskLevel: "critical",
        reasonCode: "critical_pattern",
        explanation: `匹配高危模式: ${pattern.source}`,
        shouldAsk: true
      };
    }
  }

  const tool = input.toolName.toLowerCase();
  if (tool === "bash" || tool === "execute_command") {
    // 缺省方言用保守读法：bash 发现未决的冷启动窗口 fail-closed，与 guardrail 正则层同口径；
    // 平台/环境走可注入通道，方言门控不得绑死宿主进程平台（与 RuntimeToolSafetyContext 同形）
    const powershellRulesActive =
      (input.shellKind ?? shellKindConservative(input.platform ?? process.platform, input.env ?? process.env)) === "powershell";
    const shellPatterns = powershellRulesActive ? [...MEDIUM_PATTERNS, ...POWERSHELL_MEDIUM_PATTERNS] : MEDIUM_PATTERNS;
    for (const pattern of shellPatterns) {
      if (pattern.test(value)) {
        return {
          riskLevel: "medium",
          reasonCode: "shell_write_pattern",
          explanation: "Shell 命令可能写入或改变工作区状态",
          shouldAsk: true
        };
      }
    }
    return {
      riskLevel: "low",
      reasonCode: "shell_read",
      explanation: "Shell 命令未命中写入或高危模式",
      shouldAsk: false
    };
  }

  if (tool === "write" || tool === "edit" || tool === "write_file" || tool === "edit_file") {
    if (input.path && isDependencyManifest(input.path)) {
      return {
        riskLevel: "medium",
        reasonCode: "dependency_manifest",
        explanation: "修改依赖清单或锁文件，可能改变项目依赖和外部访问范围",
        shouldAsk: true
      };
    }
    if (input.path && isSensitivePath(input.path)) {
      return {
        riskLevel: "high",
        reasonCode: "sensitive_path",
        explanation: "写入敏感路径",
        shouldAsk: true
      };
    }
    return {
      riskLevel: "medium",
      reasonCode: "file_write",
      explanation: "文件写入或编辑",
      shouldAsk: true
    };
  }

  if (input.source === "mcp" || input.source === "plugin") {
    return {
      riskLevel: "medium",
      reasonCode: "external_tool",
      explanation: "外部工具默认需要确认",
      shouldAsk: true
    };
  }

  return {
    riskLevel: "low",
    reasonCode: "metadata_low",
    explanation: "未命中高风险模式",
    shouldAsk: false
  };
}

function isSensitivePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return normalized.includes("/etc/")
    || normalized.includes("/.ssh/")
    || normalized.includes("/.env")
    || normalized.endsWith(".env");
}

function isDependencyManifest(path: string): boolean {
  return /(^|[\\/])(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)(?:$|[\\/])/i.test(path);
}
