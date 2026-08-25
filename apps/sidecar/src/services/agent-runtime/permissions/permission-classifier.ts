import { shellKindConservative } from "@lume/agent-sdk";
import { PS_DELETE_COMMAND, PS_FULL_NAME_VERBS, hasPowerShellContentSignal } from "../ps-dangerous-verbs";
import type {
  PermissionClassification,
  PermissionClassifierInput,
  PermissionClassifierLlm
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

export interface CreatePermissionClassifierOptions {
  llm?: PermissionClassifierLlm;
  timeoutMs?: number;
  cacheTtlMs?: number;
  cacheLimit?: number;
}

export function createPermissionClassifier(
  options: CreatePermissionClassifierOptions = {}
): PermissionClassifier {
  const cache = new Map<string, { result: PermissionClassification; ts: number }>();
  const timeoutMs = options.timeoutMs ?? 3_000;
  const cacheTtlMs = options.cacheTtlMs ?? 5 * 60_000;
  const cacheLimit = options.cacheLimit ?? 200;

  return {
    async classify(input) {
      const heuristic = classifyHeuristic(input);
      if (heuristic.riskLevel !== "low" || !options.llm) {
        return heuristic;
      }

      // 缓存键纳入方言（#707）：启发式词表选择依赖 shellKind，TTL 内方言读法漂移时
      // 同一命令文本不得跨方言共享 LLM 结果。JSON 序列化作键：分隔符拼接在 command/path
      // 含 "::" 时存在跨条目歧义碰撞。生产引擎缺省不传 shellKind（段为 null），注入通道
      // （测试/未来方言上下文接线）生效。
      const key = JSON.stringify([input.toolName, input.shellKind ?? null, input.command ?? "", input.path ?? ""]);
      const cached = cache.get(key);
      if (cached && Date.now() - cached.ts < cacheTtlMs) {
        return cached.result;
      }

      try {
        const response = await Promise.race([
          options.llm(buildClassifierPrompt(input)),
          new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs))
        ]);
        const parsed = parseLlmClassification(response);
        if (parsed) {
          cache.set(key, { result: parsed, ts: Date.now() });
          if (cache.size > cacheLimit) {
            const first = cache.keys().next().value;
            if (first) cache.delete(first);
          }
          return parsed;
        }
      } catch {
        return heuristic;
      }
      return heuristic;
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
    // 平台/环境走可注入通道，方言门控不得绑死宿主进程平台（与 RuntimeToolSafetyContext 同形）。
    // win32 叠加内容信号通道（#707）：装 POSIX bash 的 Windows 机上方言读作 bash、词表休眠，
    // 文本呈强 PS 形态时无视方言激活；非 win32 不消费（与 guardrail 层同口径）
    const platform = input.platform ?? process.platform;
    const powershellRulesActive =
      (input.shellKind ?? shellKindConservative(platform, input.env ?? process.env)) === "powershell" ||
      (platform === "win32" && hasPowerShellContentSignal(input.command ?? input.path ?? ""));
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
      // 中性理由（#707）：该文案经引擎 approval 透传直达审批卡，若陈述「无风险」
      // 会与「请确认」同屏自相矛盾——只陈述结论，不替系统背书安全性
      explanation: "Shell 命令不在自动放行范围内，需要用户确认",
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
    // 中性理由（#707 同源）：该文案经引擎 approval 透传直达审批卡（skill 等工具
    // 未命中词表时走此 fallback），不得陈述「无风险」与「请确认」自相矛盾
    explanation: "该操作不在自动放行范围内，需要用户确认",
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

function buildClassifierPrompt(input: PermissionClassifierInput): string {
  return [
    "你是一个安全审计助手。判断以下操作的风险等级。",
    `工具: ${input.toolName}`,
    input.description ? `描述: ${input.description}` : "",
    input.command ? `命令: ${input.command}` : "",
    input.path ? `路径: ${input.path}` : "",
    "只返回 JSON: {\"riskLevel\":\"low|medium|high|critical\",\"reason\":\"原因\",\"shouldAsk\":true}"
  ].filter(Boolean).join("\n");
}

function parseLlmClassification(response: string): PermissionClassification | null {
  try {
    const parsed = JSON.parse(response.trim()) as Record<string, unknown>;
    const rawRisk = parsed.riskLevel ?? parsed.risk;
    if (
      rawRisk !== "low" &&
      rawRisk !== "medium" &&
      rawRisk !== "high" &&
      rawRisk !== "critical"
    ) {
      return null;
    }
    return {
      riskLevel: rawRisk,
      reasonCode: "llm_classifier",
      explanation: typeof parsed.reason === "string" ? parsed.reason : "LLM 风险分类",
      shouldAsk: parsed.shouldAsk === true
    };
  } catch {
    return null;
  }
}
