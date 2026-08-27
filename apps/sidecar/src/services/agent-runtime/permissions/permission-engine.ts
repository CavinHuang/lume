import { isReadOnlyShellInput } from "@lume/agent-sdk";
import type { LumeToolRiskLevel } from "../tools/tool-types";
import { createPermissionClassifier, type PermissionClassifier } from "./permission-classifier";
import {
  buildPermissionFingerprint,
  extractPermissionCommand,
  extractPermissionPath,
  isPathWithinRoot,
  matchPermissionRule,
  toAbsolutePath
} from "./permission-rules";
import { runtimePermissionSessionStore, type PermissionSessionStore } from "./permission-session";
import type {
  PermissionDecision,
  PermissionDecisionInput,
  PermissionRule
} from "./permission-types";

export interface PermissionEngineOptions {
  classifier?: PermissionClassifier;
  session?: PermissionSessionStore;
  rules?: PermissionRule[];
  /**
   * 可注入只读判定缝：shell 输入是否经静态分析证明只读，默认 SDK 的
   * isReadOnlyShellInput。测试注入确定性读数用（ProbeOptions 惯例）。
   */
  isShellInputReadOnly?: (input: unknown) => boolean;
}

export class PermissionEngine {
  private readonly classifier: PermissionClassifier;
  private readonly session: PermissionSessionStore;
  private readonly rules: PermissionRule[];
  private readonly isShellInputReadOnly: (input: unknown) => boolean;

  constructor(options: PermissionEngineOptions = {}) {
    this.classifier = options.classifier ?? createPermissionClassifier();
    this.session = options.session ?? runtimePermissionSessionStore;
    this.rules = options.rules ?? [];
    this.isShellInputReadOnly = options.isShellInputReadOnly ?? ((input) => isReadOnlyShellInput(input));
  }

  async decide(input: PermissionDecisionInput): Promise<PermissionDecision> {
    const mode = normalizePermissionMode(input.mode);
    const riskLevel = normalizeRisk(input.descriptor.metadata.riskLevel);
    const sessionBypass = this.session.isBypassed(input.context.threadId);

    if (mode === "plan") {
      if (input.descriptor.metadata.allowedInPlanMode) {
        return allow("mode_plan", "Plan 模式允许规划与只读工具", riskLevel, input);
      }
      return deny("mode_plan", `当前是 plan 模式，只允许规划与只读工具，禁止执行: ${input.descriptor.name}`, riskLevel, input);
    }

    const rules = [...this.rules, ...(input.rules ?? [])];
    for (const rule of rules) {
      if (!matchPermissionRule({
        rule,
        descriptor: input.descriptor,
        rawInput: input.input,
        cwd: input.context.cwd
      })) {
        continue;
      }
      if (rule.action === "allow") {
        return {
          ...allow("rule_allow", "权限规则允许该工具调用", riskLevel, input),
          matchedRuleId: rule.id
        };
      }
      if (rule.action === "deny") {
        return {
          ...deny("rule_deny", "权限规则拒绝该工具调用", riskLevel, input),
          matchedRuleId: rule.id
        };
      }
      if (mode === "bypassPermissions" || sessionBypass) {
        return {
          ...bypassAllow(sessionBypass, riskLevel, input),
          matchedRuleId: rule.id
        };
      }
      return {
        ...approval("rule_ask", "权限规则要求确认该工具调用", riskLevel, input),
        matchedRuleId: rule.id
      };
    }

    if (mode === "bypassPermissions" || sessionBypass) {
      return bypassAllow(sessionBypass, riskLevel, input);
    }

    if (this.session.isGranted({
      threadId: input.context.threadId,
      descriptor: input.descriptor,
      input: input.input,
      // #775：携带 workspace 时未命中线程集再查 workspace 持久授权
      ...(input.context.workspaceSlug ? { workspaceSlug: input.context.workspaceSlug } : {})
    })) {
      return allow("session_allow", "本次会话已允许相同工具输入", riskLevel, input);
    }

    const privateRootDecision = evaluatePrivateWriteRoot(input);
    if (privateRootDecision) return privateRootDecision;

    if (mode === "acceptEdits" && isFilesystemEdit(input)) {
      return allow("mode_accept_edits", "acceptEdits 自动允许文件读写编辑", riskLevel, input);
    }

    if (
      input.descriptor.metadata.requiresApprovalByDefault === false &&
      input.descriptor.metadata.riskLevel === "low"
    ) {
      return allow("metadata_low", "工具 metadata 声明低风险且默认无需审批", "low", input);
    }

    /*
     * 内容证明免审通道（#571 第 2 项）：shell 输入经静态分析证明只读时无需任何
     * 审批——这是内容层面的证明，独立于分类器开关（classifierEnabled 只门控
     * 启发式风险判断），也不依赖 dontAsk 模式。规则表先于本分支：用户显式
     * ask/deny 的意图优先级更高。守卫层（runtime-tool-safety）在引擎之后复核，
     * 覆盖 rm/git push/PS 危险动词等结构化形态；静态白名单无法证明的写原语
     * （如仓库 textconv 配置类通道）不在其拦截面内，残余风险见 shell-read-only.ts。
     * 命名注：readonly_shell 与启发式分类器的 shell_read 判定无关联——前者是
     * 内容证明，后者是风险评级。
     */
    if (input.descriptor.canonicalName === "bash" && this.isShellInputReadOnly(input.input)) {
      return allow("readonly_shell", "命令经静态分析判定为只读，自动放行", "low", input);
    }

    if (input.classifierEnabled === false) {
      // 专属归因（#707）：开关 UI 化后此分支是普通用户可达主路径，文案须与设置页
      // 「风险分类器」开关闭环，不能误导用户去排查不存在的 metadata 问题
      return approval(
        "classifier_disabled_requires_approval",
        "风险分类器已关闭，该操作需要用户确认",
        riskLevel,
        input
      );
    }

    const classification = await this.classifier.classify({
      toolName: input.descriptor.name,
      source: input.descriptor.source,
      command: extractPermissionCommand(input.input),
      path: resolvePermissionPath(input),
      description: input.descriptor.metadata.description
    });
    const classifiedRisk = classification.riskLevel;

    if (mode === "dontAsk" && !classification.shouldAsk && classifiedRisk === "low") {
      return allow("mode_dont_ask_safe", "dontAsk 自动允许低风险工具调用", classifiedRisk, input, classification);
    }

    return approval("risk_requires_approval", classification.explanation, classifiedRisk, input, classification);
  }
}

function normalizePermissionMode(mode: PermissionDecisionInput["mode"]): Exclude<PermissionDecisionInput["mode"], undefined | "auto"> {
  if (mode === "auto") return "dontAsk";
  return mode ?? "default";
}

function evaluatePrivateWriteRoot(input: PermissionDecisionInput): PermissionDecision | null {
  const path = extractPermissionPath(input.input);
  if (!path || !isFilesystemEdit(input)) return null;
  const roots = input.context.privateWriteRoots ?? [];
  const absolutePath = toAbsolutePath(path, input.context.cwd);
  if (!roots.some((root) => isPathWithinRoot(absolutePath, root, input.context.cwd))) return null;
  return allow("private_root", "写入 Lume 私有管理目录", "low", input);
}

function isFilesystemEdit(input: PermissionDecisionInput): boolean {
  return input.descriptor.metadata.capability === "filesystem" &&
    (input.descriptor.metadata.category === "read" || input.descriptor.metadata.category === "write");
}

function resolvePermissionPath(input: PermissionDecisionInput): string | undefined {
  const path = extractPermissionPath(input.input);
  return path ? toAbsolutePath(path, input.context.cwd) : undefined;
}

function allow(
  reasonCode: string,
  explanation: string,
  riskLevel: LumeToolRiskLevel | "critical",
  input: PermissionDecisionInput,
  classification?: PermissionDecision["classification"]
): PermissionDecision {
  return {
    status: "allow",
    reasonCode,
    riskLevel,
    explanation,
    ...(classification ? { classification } : {}),
    grantSuggestion: grantSuggestion(input)
  };
}

function bypassAllow(
  sessionBypass: boolean,
  riskLevel: LumeToolRiskLevel | "critical",
  input: PermissionDecisionInput
): PermissionDecision {
  return allow(
    sessionBypass ? "session_bypass" : "mode_bypass",
    sessionBypass
      ? "本线程已切换为全部允许，但不跳过运行时安全策略"
      : "bypassPermissions 跳过审批，但不跳过运行时安全策略",
    riskLevel,
    input
  );
}

function deny(
  reasonCode: string,
  explanation: string,
  riskLevel: LumeToolRiskLevel | "critical",
  input: PermissionDecisionInput
): PermissionDecision {
  return {
    status: "deny",
    reasonCode,
    riskLevel,
    explanation,
    grantSuggestion: grantSuggestion(input)
  };
}

function approval(
  reasonCode: string,
  explanation: string,
  riskLevel: LumeToolRiskLevel | "critical",
  input: PermissionDecisionInput,
  classification?: PermissionDecision["classification"]
): PermissionDecision {
  return {
    status: "approval_required",
    reasonCode,
    riskLevel,
    explanation,
    ...(classification ? { classification } : {}),
    grantSuggestion: grantSuggestion(input)
  };
}

function grantSuggestion(input: PermissionDecisionInput): PermissionDecision["grantSuggestion"] {
  return {
    fingerprint: buildPermissionFingerprint({
      descriptor: input.descriptor,
      rawInput: input.input
    }),
    label: `允许相同 ${input.descriptor.name} 调用`
  };
}

function normalizeRisk(risk: LumeToolRiskLevel | "critical"): LumeToolRiskLevel | "critical" {
  return risk;
}
