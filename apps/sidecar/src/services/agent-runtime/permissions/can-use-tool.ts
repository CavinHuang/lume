/**
 * CanUseTool 处理器工厂(#177 自 runtime-core/attempt.ts 拆出,纯移动):
 * 插件敏感能力审批 / AskUserQuestion 会话 / workflow hook / subagent 策略 /
 * 自动化暂停五段权限逻辑与工具输入 guardrail 网关。
 */
import { isHardDeniedTool, type CanUseToolFn } from "@lume/agent-sdk";
import { randomUUID } from "node:crypto";
import type { AgentToolPermissionRequest } from "@lume/shared";
import type { PluginPermissions, SensitiveCapabilityKey } from "@lume/agent-sdk";
import { createLogger } from "../../infra/logger";
import type {
  AgentRuntimeRunParams,
  AgentRuntimeEmitter,
} from "../runtime-core/types";
import { resolveSubagentInteractiveLabel } from "../runtime-core/subagent-interactive-display";
import {
  markToolFingerprintAllowed,
  setToolPermissionApprovalSession,
  waitForToolPermissionDecision,
} from "../interruption/tool-permission-session";
import { runtimePermissionSessionStore } from "./permission-session";
import {
  setAskUserQuestionApprovalSession,
  waitForAskUserQuestionAnswers,
} from "../interruption/ask-user-question-session";
import type { AgentAskUserQuestionQuestion } from "@lume/shared";
import { builtinToolInputGuardrails } from "../guardrails/builtin-tool-guardrails";
import { LumeGuardrailRunner } from "../guardrails/guardrail-runner";
import { ToolExecutionGateway } from "../tools/tool-execution-gateway";
import { getRuntimeToolDescriptor } from "../tools/tool-descriptor-session";
import { type PreparedRuntimeCoreAttempt } from "../runner/prepare-attempt";
import { persistToolApprovalInterruption } from "../interruption/approval-service";
import { getEffectiveLumeConfig } from "../../system/lume-config-service";
import { recordPermissionDenial } from "./permission-denials";
import {
  resolveConfiguredPermissionRules,
  resolveConfiguredPrivateWriteRoots,
} from "./permission-config";
import {
  resolveSubagentCanAllowAlways,
  resolveSubagentPermissionPolicyDecision,
} from "../runtime-core/subagent-permission-policy";
import type { LumeWorkflowPermissionBeforeDecisionEvent } from "../../workflow-hooks/hook-events";
import {
  resolvePermissionDecision,
  type LumeWorkflowHookExecutionResult,
} from "../../workflow-hooks/hook-effects";
import type { LumeWorkflowHookRuntimeLike } from "../../workflow-hooks/hook-runtime";
import {
  runGuidanceStore,
  type ConsumedRunGuidance,
} from "../guidance/run-guidance-store";
import {
  createPluginPermissionInterceptor,
  type InterceptorInput,
} from "../plugins/permission-interceptor.js";
import { appendPluginAuditEntry } from "../plugins/plugin-audit-store.js";
import { PluginPermissionRuntime } from "../plugins/permission-runtime.js";
import { evaluatePluginSensitiveGate } from "../plugins/sensitive-gate.js";

const log = createLogger("can-use-tool");

const toolInputGuardrails = new LumeGuardrailRunner(builtinToolInputGuardrails);
const toolExecutionGateway = new ToolExecutionGateway({
  guardrails: toolInputGuardrails,
});

function sanitizeToolInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const record = input as Record<string, unknown>;
  const copied: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.length > 2000) {
      copied[key] = `${value.slice(0, 2000)}...(truncated)`;
    } else {
      copied[key] = value;
    }
  }
  return copied;
}

function toReadableString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return "";
}

function parseAskUserQuestions(
  input: Record<string, unknown>,
): AgentAskUserQuestionQuestion[] {
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  const result: AgentAskUserQuestionQuestion[] = [];
  for (const item of rawQuestions) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const question = toReadableString(record.question);
    const header =
      toReadableString(record.header) || `问题${result.length + 1}`;
    const rawOptions = Array.isArray(record.options) ? record.options : [];
    const options = rawOptions
      .map((option) => {
        if (typeof option === "string") {
          const text = option.trim();
          return text ? { label: text, description: text } : null;
        }
        if (!option || typeof option !== "object") return null;
        const optionRecord = option as Record<string, unknown>;
        const label =
          toReadableString(optionRecord.label) ||
          toReadableString(optionRecord.text);
        const description = toReadableString(optionRecord.description) || label;
        if (!label) return null;
        return { label, description };
      })
      .filter(
        (option): option is { label: string; description: string } => !!option,
      );
    if (!question || options.length < 2) continue;
    result.push({
      header,
      question,
      options,
      multiSelect: record.multiSelect === true,
    });
  }
  return result;
}

export async function resolveWorkflowPermissionHookResult(input: {
  workflowHooks?: LumeWorkflowHookRuntimeLike;
  event: LumeWorkflowPermissionBeforeDecisionEvent;
  disabled?: boolean;
}): Promise<{ behavior: "allow" | "deny"; message?: string } | null> {
  if (input.disabled || !input.workflowHooks) return null;
  let result: LumeWorkflowHookExecutionResult;
  try {
    result = await input.workflowHooks.execute(input.event);
  } catch {
    return null;
  }
  if (result.errors.length > 0) return null;
  const decision = resolvePermissionDecision(result.effects);
  if (!decision) return null;
  if (decision.decision === "deny") {
    return { behavior: "deny", message: decision.reason };
  }
  if (decision.decision === "allow") {
    return { behavior: "allow" };
  }
  return null;
}

export function createCanUseToolHandler(
  params: AgentRuntimeRunParams,
  prepared: PreparedRuntimeCoreAttempt,
  emit: AgentRuntimeEmitter,
  askUserSignal: AbortSignal,
  runId?: string,
  workflowHooks?: LumeWorkflowHookRuntimeLike,
  pluginInterceptorContexts?: Array<{
    pluginName: string;
    pluginRoot: string;
    permissions: Record<string, unknown>;
  }>,
  pluginPermissionRuntime?: PluginPermissionRuntime,
): CanUseToolFn {
  const config = getEffectiveLumeConfig(prepared.workspaceSlug);
  const permissionRules = resolveConfiguredPermissionRules(config.permissions);
  const privateWriteRoots = resolveConfiguredPrivateWriteRoots({
    agentCwd: prepared.agentCwd,
    lumeWorkDir: prepared.lumeWorkDir,
    filesRoot: prepared.filesRoot,
    plansRoot: prepared.plansRoot,
    artifactsRoot: prepared.artifactsRoot,
    workspaceSlug: prepared.workspaceSlug,
    configuredRoots: config.permissions?.privateWriteRoots,
  });

  // Build plugin interceptors once per handler creation
  const pluginInterceptors = (pluginInterceptorContexts ?? []).map((ctx) =>
    createPluginPermissionInterceptor(ctx),
  );
  log.debug("Plugin permission interceptors initialized", {
    count: pluginInterceptors.length,
    plugins: (pluginInterceptorContexts ?? []).map((c) => c.pluginName),
  });

  return async (tool, input, metadata) => {
    const toolName = tool.name || "unknown_tool";
    const bypassPermissions =
      params.input.permissionMode === "bypassPermissions" ||
      runtimePermissionSessionStore.isBypassed(params.runtime.sessionId);
    const sourcePluginId = (tool as { runtimeMetadata?: { pluginId?: string } })
      .runtimeMetadata?.pluginId;

    // §8.2 hard deny: a tool listed in its source plugin's
    // permissions.tools.deny is blocked unconditionally — bypassPermissions
    // must not override it (wires isHardDeniedTool, which previously had no
    // production caller, #345).
    const sourcePermissions = pluginInterceptorContexts?.find(
      (ctx) => ctx.pluginName === sourcePluginId,
    )?.permissions;
    if (
      sourcePluginId &&
      sourcePermissions &&
      isHardDeniedTool(sourcePermissions as PluginPermissions, toolName)
    ) {
      log.warn("Tool call blocked by plugin hard deny", {
        toolName,
        pluginId: sourcePluginId,
      });
      return {
        behavior: "deny" as const,
        message: `Plugin "${sourcePluginId}" hard-denied tool "${toolName}".`,
      };
    }

    // Plugin permission interceptor: run before global PermissionEngine
    for (const interceptor of pluginInterceptors) {
      const pluginResult = await interceptor({
        toolName,
        input,
        context: {
          cwd: prepared.agentCwd,
          threadId: params.runtime.sessionId,
          ...(sourcePluginId ? { sourcePluginId } : {}),
        },
      } as InterceptorInput);
      if (pluginResult) {
        log.debug("Plugin permission interceptor result", {
          toolName,
          behavior: pluginResult.behavior,
          reason: pluginResult.reason,
        });
      }
      if (pluginResult?.behavior === "deny") {
        log.warn("Tool call blocked by plugin permission", {
          toolName,
          reason: pluginResult.reason,
        });
        return {
          behavior: "deny" as const,
          message: pluginResult.reason ?? `Plugin denied tool: ${toolName}`,
          updatedInput: pluginResult.updatedInput,
        };
      }
      if (pluginResult?.behavior === "allow") {
        log.debug("Tool call allowed by plugin permission", { toolName });
        return {
          behavior: "allow" as const,
          updatedInput: pluginResult.updatedInput,
        };
      }
      // "ask" or undefined: continue to global permission engine
    }
    const approvalThreadId =
      params.runtime.deliveryThreadId ?? params.runtime.sessionId;
    const originThreadId = params.runtime.deliveryThreadId
      ? params.runtime.sessionId
      : undefined;
    const subagentRunId = params.runtime.subagentRunId;
    const subagentLabel = resolveSubagentInteractiveLabel(subagentRunId);
    const automationExecution = isAutomationExecution(
      params.input.messageMetadata,
    );
    const requestRunId = runId;
    const toolStartTime = Date.now();
    log.debug("[Agent 工具] 调用", {
      toolName,
      threadId: params.runtime.sessionId.slice(0, 8),
      toolUseId: metadata?.toolUseId,
    });
    const pendingGuidance = runGuidanceStore.consumePendingGuidance(
      params.runtime.sessionId,
    );
    if (pendingGuidance) {
      emit.onRuntimeEvent?.({
        id: `${requestRunId ?? params.runtime.sessionId}:${metadata?.toolUseId ?? toolName}:guidance.delivered`,
        type: "guidance.delivered",
        threadId: params.runtime.sessionId,
        runId: requestRunId ?? params.runtime.sessionId,
        createdAt: new Date().toISOString(),
        guidanceIds: pendingGuidance.guidanceIds,
        text: pendingGuidance.text,
      });
      log.debug("[Agent 工具] 完成", {
        toolName,
        threadId: params.runtime.sessionId.slice(0, 8),
        durationMs: Date.now() - toolStartTime,
        ok: false,
        reason: "guidance_delivered",
      });
      return {
        behavior: "deny",
        message: buildPendingGuidanceToolMessage(pendingGuidance),
      };
    }
    const descriptor = getRuntimeToolDescriptor(
      params.runtime.sessionId,
      toolName,
    );
    if (!descriptor) {
      recordPermissionDenial({
        threadId: params.runtime.sessionId,
        toolName,
        rawInput: input,
        reasonCode: "descriptor_missing",
      });
      log.debug("[Agent 工具] 完成", {
        toolName,
        threadId: params.runtime.sessionId.slice(0, 8),
        durationMs: Date.now() - toolStartTime,
        ok: false,
        reason: "descriptor_missing",
      });
      return {
        behavior: "deny",
        message: `工具未注册到 Runtime descriptor: ${toolName}`,
      };
    }
    // Phase 4A: plugin sensitive-capability gate (§8.1/§8.2). Source-bound: only affects
    // tools whose descriptor carries runtimeMetadata.pluginId. Runs after descriptor lookup
    // and before the global gateway. `allow` → pass; `ask` (no prior approval) → interactive
    // prompt via waitForToolPermissionDecision (allow_always persists approval); `deny`
    // (prior deny) → hard block.
    if (pluginPermissionRuntime) {
      const gateResult = await evaluatePluginSensitiveGate({
        descriptor,
        runtime: pluginPermissionRuntime,
        workspaceSlug: prepared.workspaceSlug,
      });
      if (gateResult.decision === "block") {
        recordPermissionDenial({
          threadId: params.runtime.sessionId,
          descriptor,
          toolName,
          rawInput: input,
          reasonCode: "permission_review_required",
        });
        // Phase 4B: capability_blocked audit hook. The block branch's gateResult carries
        // no pluginId (only ask does, per sensitive-gate.ts); source it from the descriptor.
        const blockPluginId =
          (descriptor.definition as { runtimeMetadata?: { pluginId?: string } })
            .runtimeMetadata?.pluginId ?? toolName;
        void appendPluginAuditEntry(undefined, {
          pluginId: blockPluginId,
          type: "capability_blocked",
          summary: `Plugin tool ${toolName} blocked (prior deny)`,
          ...(prepared.workspaceSlug
            ? { workspaceSlug: prepared.workspaceSlug }
            : {}),
          metadata: { toolName, reason: gateResult.reason },
        });
        log.debug("[Agent 工具] 完成", {
          toolName,
          threadId: params.runtime.sessionId.slice(0, 8),
          durationMs: Date.now() - toolStartTime,
          ok: false,
          reason: "plugin_sensitive_blocked",
        });
        return {
          behavior: "deny",
          message:
            gateResult.reason ??
            `Plugin tool ${toolName} blocked by sensitive-capability gate.`,
        };
      }
      if (gateResult.decision === "ask" && bypassPermissions) {
        log.debug("Plugin sensitive approval bypassed by permission mode", {
          toolName,
        });
      } else if (
        gateResult.decision === "ask" &&
        gateResult.pluginId &&
        gateResult.capabilityKey
      ) {
        // Phase 4A: interactive plugin sensitive approval via the existing tool-permission pipeline.
        const pluginRequest: AgentToolPermissionRequest = {
          threadId: approvalThreadId,
          ...(requestRunId ? { runId: requestRunId } : {}),
          requestId: `${params.runtime.sessionId}:${toolName}:${randomUUID()}`,
          toolUseId: `plugin-sensitive:${toolName}`,
          toolName,
          risk: "high",
          reason:
            gateResult.reason ??
            `插件 ${gateResult.pluginId} 请求敏感能力 ${gateResult.capabilityKey}`,
          reasonCode: "plugin_sensitive_review",
          input: sanitizeToolInput(input),
          pluginSensitive: {
            pluginId: gateResult.pluginId,
            capabilityKey: gateResult.capabilityKey,
          },
        };
        let pluginTimedOut = false;
        const pluginDecision = await waitForToolPermissionDecision(
          pluginRequest,
          askUserSignal,
          (permissionRequest) => {
            if (approvalThreadId !== permissionRequest.threadId) {
              setToolPermissionApprovalSession(
                permissionRequest.requestId,
                approvalThreadId,
              );
            }
            emit.onToolPermissionRequest(permissionRequest);
          },
          {
            onTimeout: (permissionRequest) => {
              pluginTimedOut = true;
              emit.onRuntimeEvent?.({
                id: `${requestRunId ?? params.runtime.sessionId}:${permissionRequest.toolUseId}:tool.permission_timeout`,
                type: "tool.permission_timeout",
                threadId: approvalThreadId,
                runId:
                  requestRunId ??
                  permissionRequest.runId ??
                  params.runtime.sessionId,
                createdAt: new Date().toISOString(),
                toolCallId: permissionRequest.toolUseId,
                requestId: permissionRequest.requestId,
                toolName,
                message: `插件权限确认超时: ${toolName}`,
              });
            },
          },
        );
        if (pluginDecision === "allow_always") {
          // Persist a workspace-scoped approval so the next attempt's
          // checkSensitiveCapability returns allow. The record is stamped with
          // the hash the gate evaluated against (#344 follow-up): #344's hash
          // filter treats only EMPTY hashes as legacy wildcards, so writing ""
          // here would exempt the main approval path from hash scoping. The
          // empty-string fallback covers degenerate records without any
          // accepted hash (pre-existing data).
          try {
            await pluginPermissionRuntime.appendSensitiveApproval({
              pluginId: gateResult.pluginId,
              record: {
                key: gateResult.capabilityKey as SensitiveCapabilityKey,
                scope: "workspace",
                ...(prepared.workspaceSlug
                  ? { workspaceSlug: prepared.workspaceSlug }
                  : {}),
                decision: "allow",
                createdAt: new Date().toISOString(),
                permissionsHash: gateResult.permissionsHash ?? "",
              },
            });
          } catch (error) {
            log.warn(
              "Plugin sensitive approval persist failed; allowing once only",
              {
                pluginId: gateResult.pluginId,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          }
          // Phase 4B: sensitive_approval audit hook (workspace-scoped allow_always).
          void appendPluginAuditEntry(undefined, {
            pluginId: gateResult.pluginId,
            type: "sensitive_approval",
            summary: `Plugin ${gateResult.pluginId} sensitive capability approved (always, workspace)`,
            ...(prepared.workspaceSlug
              ? { workspaceSlug: prepared.workspaceSlug }
              : {}),
            metadata: {
              capabilityKey: gateResult.capabilityKey,
              toolName,
              scope: "workspace",
            },
          });
          log.debug("[Agent 工具] 完成", {
            toolName,
            threadId: params.runtime.sessionId.slice(0, 8),
            durationMs: Date.now() - toolStartTime,
            ok: true,
            reason: "plugin_sensitive_allow_always",
          });
          return { behavior: "allow" };
        }
        if (pluginDecision === "allow_once") {
          log.debug("[Agent 工具] 完成", {
            toolName,
            threadId: params.runtime.sessionId.slice(0, 8),
            durationMs: Date.now() - toolStartTime,
            ok: true,
            reason: "plugin_sensitive_allow_once",
          });
          return { behavior: "allow" };
        }
        // deny / timeout / null (aborted)
        recordPermissionDenial({
          threadId: params.runtime.sessionId,
          descriptor,
          toolName,
          rawInput: input,
          reasonCode: pluginTimedOut ? "approval_timeout" : "user_denied",
        });
        // Phase 4B: sensitive_denial audit hook (user denied or approval timed out).
        void appendPluginAuditEntry(undefined, {
          pluginId: gateResult.pluginId,
          type: "sensitive_denial",
          summary: pluginTimedOut
            ? `Plugin ${gateResult.pluginId} sensitive approval timed out`
            : `Plugin ${gateResult.pluginId} sensitive capability denied`,
          ...(prepared.workspaceSlug
            ? { workspaceSlug: prepared.workspaceSlug }
            : {}),
          metadata: {
            capabilityKey: gateResult.capabilityKey,
            toolName,
            reason: pluginTimedOut ? "timeout" : "user_denied",
          },
        });
        log.debug("[Agent 工具] 完成", {
          toolName,
          threadId: params.runtime.sessionId.slice(0, 8),
          durationMs: Date.now() - toolStartTime,
          ok: false,
          reason: pluginTimedOut
            ? "plugin_sensitive_timeout"
            : "plugin_sensitive_denied",
        });
        return {
          behavior: "deny",
          message: pluginTimedOut
            ? `插件权限确认超时: ${toolName}`
            : `用户拒绝执行插件工具: ${toolName}`,
        };
      }
    }
    const authorization = await toolExecutionGateway.authorize({
      toolName,
      descriptor,
      input,
      permissionMode: params.input.permissionMode,
      // 字段缺失 = 启用（#571 第 1 项）：新默认开启启发式分类；v1 存量文件的
      // 显式 false 由 lume-config-service 的 v2 迁移一次性翻转为 true。
      classifierEnabled: config.permissions?.classifier?.enabled ?? true,
      permissionRules,
      privateWriteRoots,
      context: {
        threadId: params.runtime.sessionId,
        cwd: prepared.agentCwd,
        additionalDirectories: privateWriteRoots,
        workspaceSlug: prepared.workspaceSlug,
      },
    });
    if (authorization.status === "deny") {
      recordPermissionDenial({
        threadId: params.runtime.sessionId,
        descriptor,
        toolName,
        rawInput: input,
        reasonCode: authorization.reasonCode,
      });
      log.debug("[Agent 工具] 完成", {
        toolName,
        threadId: params.runtime.sessionId.slice(0, 8),
        durationMs: Date.now() - toolStartTime,
        ok: false,
        reason: "denied",
      });
      return {
        behavior: "deny",
        message: authorization.message,
      };
    }

    if (toolName === "AskUserQuestion") {
      const normalizedInput =
        input && typeof input === "object"
          ? (input as Record<string, unknown>)
          : {};
      const questions = parseAskUserQuestions(normalizedInput);
      if (questions.length === 0) {
        log.debug("[Agent 工具] 完成", {
          toolName,
          threadId: params.runtime.sessionId.slice(0, 8),
          durationMs: Date.now() - toolStartTime,
          ok: false,
          reason: "denied",
        });
        return {
          behavior: "deny",
          message: "AskUserQuestion 缺少有效问题，已拒绝执行",
        };
      }
      const askResult = await waitForAskUserQuestionAnswers(
        params.runtime.sessionId,
        metadata?.toolUseId ?? toolName,
        questions,
        askUserSignal,
        (request) => {
          if (approvalThreadId !== request.threadId) {
            setAskUserQuestionApprovalSession(
              request.toolUseId,
              approvalThreadId,
            );
          }
          emit.onAskUserQuestion({
            ...request,
            ...(requestRunId ? { runId: requestRunId } : {}),
            threadId: approvalThreadId,
            ...(originThreadId ? { originThreadId } : {}),
            ...(subagentRunId ? { subagentRunId } : {}),
            ...(subagentLabel ? { subagentLabel } : {}),
          });
        },
        {
          ...(requestRunId ? { runId: requestRunId } : {}),
          originThreadId,
          subagentRunId,
          subagentLabel,
        },
      );
      if (askResult.status !== "answered" || !askResult.answers) {
        log.debug("[Agent 工具] 完成", {
          toolName,
          threadId: params.runtime.sessionId.slice(0, 8),
          durationMs: Date.now() - toolStartTime,
          ok: false,
          reason: "denied",
        });
        if (askResult.status === "timeout") {
          return {
            behavior: "deny",
            message: "AskUserQuestion 等待用户回答超时",
          };
        }
        if (askResult.status === "aborted") {
          return { behavior: "deny", message: "AskUserQuestion 被线程中止" };
        }
        return { behavior: "deny", message: "用户取消了 AskUserQuestion" };
      }
      const result = {
        behavior: "allow" as const,
        updatedInput: {
          ...normalizedInput,
          questions,
          answers: askResult.answers,
        },
      };
      log.debug("[Agent 工具] 完成", {
        toolName,
        threadId: params.runtime.sessionId.slice(0, 8),
        durationMs: Date.now() - toolStartTime,
        ok: true,
      });
      return result;
    }

    const hookDecision = await resolveWorkflowPermissionHookResult({
      workflowHooks,
      event: {
        event: "permission.beforeDecision",
        runId: requestRunId ?? params.runtime.sessionId,
        threadId: params.runtime.sessionId,
        ...(params.runtime.workspaceId
          ? { workspaceId: params.runtime.workspaceId }
          : {}),
        workspaceSlug: prepared.workspaceSlug,
        cwd: prepared.agentCwd,
        permissionMode: params.input.permissionMode,
        threadType: params.runtime.threadType,
        chatType: params.input.chatType,
        messageMetadata: params.input.messageMetadata,
        toolName,
        toolInputSummary: JSON.stringify(sanitizeToolInput(input)),
        gatewayDecision:
          authorization.status === "approval_required"
            ? "ask"
            : authorization.status,
        risk: authorization.risk,
        reasonCode: authorization.reasonCode,
      },
    });
    if (hookDecision) {
      log.debug("[Agent 工具] 完成", {
        toolName,
        threadId: params.runtime.sessionId.slice(0, 8),
        durationMs: Date.now() - toolStartTime,
        ok: hookDecision.behavior === "allow",
        reason:
          hookDecision.behavior === "deny" ? "workflow_hook_denied" : undefined,
      });
      if (hookDecision.behavior === "deny") {
        recordPermissionDenial({
          threadId: params.runtime.sessionId,
          descriptor,
          toolName,
          rawInput: input,
          reasonCode: "workflow_hook_denied",
        });
      }
      return hookDecision;
    }

    if (authorization.status === "allow") {
      log.debug("[Agent 工具] 完成", {
        toolName,
        threadId: params.runtime.sessionId.slice(0, 8),
        durationMs: Date.now() - toolStartTime,
        ok: true,
      });
      return { behavior: "allow" };
    }

    const grantFingerprint = authorization.grantSuggestion?.fingerprint;
    const canAllowAlways = resolveSubagentCanAllowAlways({
      isSubagent: Boolean(subagentRunId),
      allowAlways: config.permissions?.approvals?.subagent?.allowAlways,
      hasGrantSuggestion: Boolean(grantFingerprint),
    });

    const subagentPolicyDecision = resolveSubagentPermissionPolicyDecision({
      isSubagent: Boolean(subagentRunId),
      mode: config.permissions?.approvals?.subagent?.mode,
      authorizationStatus: authorization.status,
      risk: authorization.risk,
      toolName,
    });
    if (subagentPolicyDecision) {
      recordPermissionDenial({
        threadId: params.runtime.sessionId,
        descriptor,
        toolName,
        rawInput: input,
        reasonCode: subagentPolicyDecision.reasonCode,
      });
      log.debug("[Agent 工具] 完成", {
        toolName,
        threadId: params.runtime.sessionId.slice(0, 8),
        durationMs: Date.now() - toolStartTime,
        ok: false,
        reason: subagentPolicyDecision.reasonCode,
      });
      return {
        behavior: subagentPolicyDecision.behavior,
        message: subagentPolicyDecision.message,
      };
    }

    const request = {
      threadId: params.runtime.sessionId,
      ...(requestRunId ? { runId: requestRunId } : {}),
      ...(originThreadId ? { originThreadId } : {}),
      ...(subagentRunId ? { subagentRunId } : {}),
      ...(subagentLabel ? { subagentLabel } : {}),
      requestId: metadata?.toolUseId ?? toolName,
      toolUseId: metadata?.toolUseId ?? toolName,
      toolName,
      risk: authorization.risk,
      reason: authorization.reason,
      reasonCode: authorization.reasonCode,
      ...(authorization.matchedRuleId
        ? { matchedRuleId: authorization.matchedRuleId }
        : {}),
      ...(authorization.classification
        ? { classification: authorization.classification }
        : {}),
      ...(authorization.grantSuggestion
        ? { grantSuggestion: authorization.grantSuggestion }
        : {}),
      canAllowAlways,
      input: sanitizeToolInput(input),
      ...(automationExecution
        ? {
            interruptionType: "automation_approval" as const,
            ...(typeof params.input.messageMetadata?.automationJobId ===
            "string"
              ? {
                  automationJobId: params.input.messageMetadata.automationJobId,
                }
              : {}),
            ...(typeof params.input.messageMetadata?.automationTrigger ===
            "string"
              ? {
                  automationTrigger:
                    params.input.messageMetadata.automationTrigger,
                }
              : {}),
          }
        : {}),
    } as const;

    if (automationExecution) {
      await persistToolApprovalInterruption(request);
      emit.onToolPermissionRequest({
        ...request,
        threadId: approvalThreadId,
        ...(originThreadId ? { originThreadId } : {}),
        ...(subagentRunId ? { subagentRunId } : {}),
        ...(subagentLabel ? { subagentLabel } : {}),
      });
      log.debug("[Agent 工具] 完成", {
        toolName,
        threadId: params.runtime.sessionId.slice(0, 8),
        durationMs: Date.now() - toolStartTime,
        ok: false,
        reason: "denied",
      });
      return {
        behavior: "deny",
        message: `自动化任务已暂停，等待用户确认工具执行: ${toolName}`,
      };
    }

    let permissionTimedOut = false;
    const decision = await waitForToolPermissionDecision(
      request,
      askUserSignal,
      (permissionRequest) => {
        if (approvalThreadId !== permissionRequest.threadId) {
          setToolPermissionApprovalSession(
            permissionRequest.requestId,
            approvalThreadId,
          );
        }
        emit.onToolPermissionRequest({
          ...permissionRequest,
          threadId: approvalThreadId,
          ...(originThreadId ? { originThreadId } : {}),
          ...(subagentRunId ? { subagentRunId } : {}),
          ...(subagentLabel ? { subagentLabel } : {}),
        });
      },
      {
        onTimeout: (permissionRequest) => {
          permissionTimedOut = true;
          emit.onRuntimeEvent?.({
            id: `${requestRunId ?? params.runtime.sessionId}:${permissionRequest.toolUseId}:tool.permission_timeout`,
            type: "tool.permission_timeout",
            threadId: approvalThreadId,
            runId:
              requestRunId ??
              permissionRequest.runId ??
              params.runtime.sessionId,
            createdAt: new Date().toISOString(),
            toolCallId: permissionRequest.toolUseId,
            requestId: permissionRequest.requestId,
            toolName,
            message: `工具权限确认超时: ${toolName}`,
          });
        },
      },
    );
    if (decision === "allow_always") {
      markToolFingerprintAllowed(params.runtime.sessionId, grantFingerprint);
      log.debug("[Agent 工具] 完成", {
        toolName,
        threadId: params.runtime.sessionId.slice(0, 8),
        durationMs: Date.now() - toolStartTime,
        ok: true,
      });
      return { behavior: "allow" };
    }
    if (decision === "allow_once") {
      log.debug("[Agent 工具] 完成", {
        toolName,
        threadId: params.runtime.sessionId.slice(0, 8),
        durationMs: Date.now() - toolStartTime,
        ok: true,
      });
      return { behavior: "allow" };
    }
    log.debug("[Agent 工具] 完成", {
      toolName,
      threadId: params.runtime.sessionId.slice(0, 8),
      durationMs: Date.now() - toolStartTime,
      ok: false,
      reason: "denied",
    });
    recordPermissionDenial({
      threadId: params.runtime.sessionId,
      descriptor: getRuntimeToolDescriptor(params.runtime.sessionId, toolName),
      toolName,
      rawInput: input,
      reasonCode: permissionTimedOut ? "approval_timeout" : "user_denied",
    });
    return {
      behavior: "deny",
      message: permissionTimedOut
        ? `工具权限确认超时: ${toolName}`
        : `用户拒绝执行工具: ${toolName}`,
    };
  };
}

function buildPendingGuidanceToolMessage(
  guidance: ConsumedRunGuidance,
): string {
  const sections = ["用户在工具执行前追加了引导：", guidance.text];
  if (
    guidance.attachmentsBrief &&
    guidance.attachmentsBrief.trim().length > 0
  ) {
    sections.push("", "附带上下文：", guidance.attachmentsBrief);
  }
  sections.push(
    "",
    "原工具调用尚未执行。请根据这条引导重新决定下一步；如果仍需要工具，请重新发起工具调用。",
  );
  return sections.join("\n");
}

function isAutomationExecution(
  messageMetadata?: Record<string, unknown>,
): boolean {
  if (!messageMetadata) return false;
  return (
    typeof messageMetadata.automationJobId === "string" ||
    typeof messageMetadata.automationTrigger === "string"
  );
}
