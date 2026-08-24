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
  /(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)/i,
  // PowerShell 破坏性动词：Windows 无 bash 回退时与上方 POSIX 词表同档兜底，避免删除/停服等被判 low
  /\b(?:remove-item|clear-content|stop-process|stop-service|stop-computer|restart-computer|set-executionpolicy|invoke-expression|iex)\b/i,
  /(?:^|[;&|(])\s*(?:rd|rmdir|del|erase|ri)\b/i
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

      const key = `${input.toolName}::${input.command ?? ""}::${input.path ?? ""}`;
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
    for (const pattern of MEDIUM_PATTERNS) {
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
