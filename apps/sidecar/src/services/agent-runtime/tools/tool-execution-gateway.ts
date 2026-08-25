import type { LumeGuardrailContext } from "../guardrails/guardrail-types";
import type { LumeGuardrailRunner } from "../guardrails/guardrail-runner";
import { PermissionRuntime } from "../permissions/permission-runtime";
import type {
  PermissionClassification,
  PermissionGrantSuggestion,
  PermissionRuntimeMode,
  PermissionRule
} from "../permissions/permission-types";
import type { LumeToolDescriptor, LumeToolRiskLevel } from "./tool-types";

export type ToolExecutionAuthorization =
  | {
    status: "allow";
    reasonCode: string;
    risk: "low" | "medium" | "high";
    classification?: PermissionClassification;
    grantSuggestion?: PermissionGrantSuggestion;
    matchedRuleId?: string;
  }
  | {
    status: "deny";
    message: string;
    reasonCode: string;
    risk: "low" | "medium" | "high";
    classification?: PermissionClassification;
    grantSuggestion?: PermissionGrantSuggestion;
    matchedRuleId?: string;
  }
  | {
    status: "approval_required";
    reason: string;
    risk: "low" | "medium" | "high";
    reasonCode: string;
    classification?: PermissionClassification;
    grantSuggestion?: PermissionGrantSuggestion;
    matchedRuleId?: string;
  };

export interface ToolExecutionGatewayInput {
  toolName: string;
  descriptor: LumeToolDescriptor;
  input: unknown;
  permissionMode?: PermissionRuntimeMode;
  classifierEnabled?: boolean;
  permissionRules?: PermissionRule[];
  privateWriteRoots?: string[];
  context: LumeGuardrailContext;
}

export class ToolExecutionGateway {
  private readonly permissionRuntime: Pick<PermissionRuntime, "authorize">;

  constructor(private readonly deps: {
    guardrails: LumeGuardrailRunner;
    permissionRuntime?: Pick<PermissionRuntime, "authorize">;
  }) {
    this.permissionRuntime = deps.permissionRuntime ?? new PermissionRuntime();
  }

  async authorize(input: ToolExecutionGatewayInput): Promise<ToolExecutionAuthorization> {
    /*
     * 一条 bash 命令从输入到执行的完整判定链（权威地图，各站点带指针）：
     * ① plan 早退 → ② 用户规则表(allow/deny/ask 先到先得) → ③ bypass/session 指纹 →
     * ④ privateWriteRoots / acceptEdits / metadata_low → ⑤ readonly_shell 内容证明 →
     * ⑥ classifierEnabled 门 + 启发式分类 —— 以上全部在 PermissionEngine.decide
     *   （../permissions/permission-engine.ts）。
     * ⑦ 出引擎后本方法先跑 deny 直通，再无条件跑守卫层复核
     *   （../guardrails/runtime-tool-safety.ts：硬拒/确认/放行三态），
     *   合并语义：deny > 守卫 confirm > 引擎 allow——confirm 会翻回已 allow 的
     *   决策（含 session_allow），且该 confirm 不持久化，故「始终允许」只对
     *   引擎层决策有效；bypass 类模式豁免 confirm 但豁免不了硬拒。
     */
    const permissionDecision = await this.permissionRuntime.authorize({
      descriptor: input.descriptor,
      input: input.input,
      mode: input.permissionMode,
      classifierEnabled: input.classifierEnabled,
      context: {
        threadId: input.context.threadId,
        cwd: input.context.cwd,
        workspaceSlug: input.context.workspaceSlug,
        privateWriteRoots: input.privateWriteRoots
      },
      rules: input.permissionRules
    });

    if (permissionDecision.status === "deny") {
      return {
        status: "deny",
        message: permissionDecision.explanation,
        reasonCode: permissionDecision.reasonCode,
        risk: toToolPermissionRisk(permissionDecision.riskLevel),
        ...(permissionDecision.classification ? { classification: permissionDecision.classification } : {}),
        ...(permissionDecision.grantSuggestion ? { grantSuggestion: permissionDecision.grantSuggestion } : {}),
        ...(permissionDecision.matchedRuleId ? { matchedRuleId: permissionDecision.matchedRuleId } : {})
      };
    }

    const inputSafety = await this.deps.guardrails.runToolInputGuardrails({
      toolName: input.toolName,
      input: input.input,
      context: {
        ...input.context,
        permissionMode: input.permissionMode
      }
    });
    if (inputSafety.behavior === "reject") {
      return {
        status: "deny",
        message: `工具参数被拒绝: ${inputSafety.reason}`,
        reasonCode: "guardrail_reject",
        risk: toToolPermissionRisk(permissionDecision.riskLevel),
        ...(permissionDecision.classification ? { classification: permissionDecision.classification } : {}),
        ...(permissionDecision.grantSuggestion ? { grantSuggestion: permissionDecision.grantSuggestion } : {}),
        ...(permissionDecision.matchedRuleId ? { matchedRuleId: permissionDecision.matchedRuleId } : {})
      };
    }

    const bypassesConfirmation = input.permissionMode === "bypassPermissions"
      || permissionDecision.reasonCode === "session_bypass";
    if (inputSafety.behavior === "require_approval" && !bypassesConfirmation) {
      /*
       * 守卫层翻回的审批不携带 grantSuggestion（#684 二轮 F2）：「始终允许」的
       * 会话指纹只约束引擎决策（session_allow），gateway 在引擎判定之后仍会
       * 无条件复核守卫——授予指纹后同一命令下次照样弹卡，按钮是空头支票。
       * canAllowAlways 由 hasGrantSuggestion 推导，置空即隐藏该按钮；
       * 「本线程内自动执行」逃生通道不受影响。
       */
      return {
        status: "approval_required",
        reason: inputSafety.reason ?? permissionDecision.explanation,
        risk: toToolPermissionRisk(permissionDecision.riskLevel),
        reasonCode: "guardrail_approval",
        ...(permissionDecision.classification ? { classification: permissionDecision.classification } : {}),
        ...(permissionDecision.matchedRuleId ? { matchedRuleId: permissionDecision.matchedRuleId } : {})
      };
    }

    if (inputSafety.behavior === "require_approval" && bypassesConfirmation) {
      return {
        status: "allow",
        reasonCode: "bypass_guardrail_confirmation",
        risk: toToolPermissionRisk(permissionDecision.riskLevel),
        ...(permissionDecision.classification ? { classification: permissionDecision.classification } : {}),
        ...(permissionDecision.grantSuggestion ? { grantSuggestion: permissionDecision.grantSuggestion } : {}),
        ...(permissionDecision.matchedRuleId ? { matchedRuleId: permissionDecision.matchedRuleId } : {})
      };
    }

    if (permissionDecision.status === "allow") {
      return {
        status: "allow",
        reasonCode: permissionDecision.reasonCode,
        risk: toToolPermissionRisk(permissionDecision.riskLevel),
        ...(permissionDecision.classification ? { classification: permissionDecision.classification } : {}),
        ...(permissionDecision.grantSuggestion ? { grantSuggestion: permissionDecision.grantSuggestion } : {}),
        ...(permissionDecision.matchedRuleId ? { matchedRuleId: permissionDecision.matchedRuleId } : {})
      };
    }

    return {
      status: "approval_required",
      reason: permissionDecision.explanation,
      risk: toToolPermissionRisk(permissionDecision.riskLevel),
      reasonCode: permissionDecision.reasonCode,
      ...(permissionDecision.classification ? { classification: permissionDecision.classification } : {}),
      ...(permissionDecision.grantSuggestion ? { grantSuggestion: permissionDecision.grantSuggestion } : {}),
      ...(permissionDecision.matchedRuleId ? { matchedRuleId: permissionDecision.matchedRuleId } : {})
    };
  }
}

function toToolPermissionRisk(risk: LumeToolRiskLevel | "critical"): "low" | "medium" | "high" {
  return risk === "critical" ? "high" : risk;
}
