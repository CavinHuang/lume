import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { filterTools, type AgentDefinition, type ToolDefinition } from "@lume/agent-sdk";
import type { AgentSendInput } from "@lume/shared";
import { ToolRegistry } from "./tool-registry";
import { ToolResolver } from "./tool-resolver";
import { createToolDescriptorsFromDefinitions } from "./tool-source";
import { getRuntimeFileAccessLedger } from "./file-access-ledger";
import { wrapToolDefinitionWithRuntimePolicies } from "./tool-runtime-wrapper";
import { createLogger } from "../../infra/logger";
import {
  resolveEffectiveToolPolicies,
  type ResolveEffectiveToolPolicyInput
} from "./tool-policy-matcher";
import type { LumeToolDescriptor, LumeToolSource } from "./tool-types";

export interface ToolRuntimeDiagnostic {
  pluginName?: string;
  path?: string;
  severity: "info" | "warning" | "error";
  reason: string;
  /** Optional structured code from the source diagnostic (e.g. capability_filtered, invalid_manifest). */
  code?: string;
}

export interface ToolRuntimeBuildInput {
  cwd: string;
  sessionId: string;
  permissionMode?: AgentSendInput["permissionMode"];
  threadType?: AgentSendInput["threadType"];
  subagentDefinition?: AgentDefinition;
  messageMetadata?: Record<string, unknown>;
  policyInput: ResolveEffectiveToolPolicyInput;
  pluginDiagnostics?: ToolRuntimeDiagnostic[];
  mcpDiagnostics?: ToolRuntimeDiagnostic[];
  groups: Array<{
    source: LumeToolSource;
    tools: ToolDefinition[];
  }>;
}

export interface ToolRuntimeBuildResult {
  tools: ToolDefinition[];
  availableToolNames: string[];
  descriptorsByCanonicalName: Map<string, LumeToolDescriptor>;
  pluginDiagnostics: ToolRuntimeDiagnostic[];
  mcpDiagnostics: ToolRuntimeDiagnostic[];
}

const log = createLogger("plugin-tool-runtime");

export const TASK_MANAGEMENT_DENY_SET = new Set([
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TaskStop",
  "ProcessOutput",
  "ProcessStop",
]);

export class ToolRuntime {
  static build(input: ToolRuntimeBuildInput): ToolRuntimeBuildResult {
    const descriptors = resolveDescriptors(input);
    const tools = materializeRuntimeTools({
      descriptors,
      threadId: input.sessionId,
      cwd: input.cwd
    });

    return {
      tools,
      availableToolNames: Array.from(new Set(tools.map((tool) => tool.name))),
      descriptorsByCanonicalName: new Map(descriptors.map((descriptor) => [
        descriptor.canonicalName,
        descriptor
      ])),
      pluginDiagnostics: input.pluginDiagnostics ?? [],
      mcpDiagnostics: input.mcpDiagnostics ?? []
    };
  }

  static resolveDynamicTools(input: {
    tools: ToolDefinition[];
    requiredTools?: ToolDefinition[];
    cwd: string;
    sessionId: string;
    threadType?: AgentSendInput["threadType"];
    permissionMode?: AgentSendInput["permissionMode"];
    messageMetadata?: Record<string, unknown>;
    policyInput: ResolveEffectiveToolPolicyInput;
  }): ToolDefinition[] {
    const descriptors = resolveDescriptors({
      cwd: input.cwd,
      sessionId: input.sessionId,
      threadType: input.threadType,
      permissionMode: input.permissionMode,
      messageMetadata: input.messageMetadata,
      policyInput: input.policyInput,
      groups: [{ source: "sdk", tools: input.tools }]
    });
    const descriptorsByCanonicalName = new Map(descriptors.map((descriptor) => [descriptor.canonicalName, descriptor]));
    const requiredToolNames = new Set<string>();
    if (input.requiredTools?.length) {
      const requiredRegistry = new ToolRegistry();
      requiredRegistry.registerMany(createToolDescriptorsFromDefinitions(input.requiredTools, "task"));
      for (const descriptor of requiredRegistry.list()) {
        requiredToolNames.add(descriptor.name);
        descriptorsByCanonicalName.set(descriptor.canonicalName, {
          ...descriptor,
          metadata: {
            ...descriptor.metadata,
            allowedInPlanMode: true
          }
        });
      }
    }
    const resolvedDescriptors = Array.from(descriptorsByCanonicalName.values());
    if (input.threadType === "subagent") {
      const residual = resolvedDescriptors.filter((descriptor) => TASK_MANAGEMENT_DENY_SET.has(descriptor.name));
      if (residual.length > 0) throw new Error(`Subagent task-management deny set violated: ${residual.map((item) => item.name).join(", ")}`);
    }
    return materializeRuntimeTools({
      descriptors: resolvedDescriptors,
      threadId: input.sessionId,
      cwd: input.cwd
    }).map((tool) => requiredToolNames.has(tool.name) ? {
      ...tool,
      runtimeMetadata: {
        ...tool.runtimeMetadata,
        requiredDuringSkillScope: true
      }
    } : tool);
  }
}

function resolveDescriptors(input: ToolRuntimeBuildInput): LumeToolDescriptor[] {
  const registry = new ToolRegistry();
  for (const group of input.groups) {
    registry.registerMany(createToolDescriptorsFromDefinitions(group.tools, group.source));
  }

  let descriptors = new ToolResolver(registry)
    .resolve({
      permissionMode: input.permissionMode,
      messageMetadata: input.messageMetadata,
      policies: resolveEffectiveToolPolicies(input.policyInput)
    });

  if (input.threadType === "subagent") {
    descriptors = descriptors.filter((descriptor) => descriptor.name !== "Agent" && !TASK_MANAGEMENT_DENY_SET.has(descriptor.name));
    const residual = descriptors.filter((descriptor) => TASK_MANAGEMENT_DENY_SET.has(descriptor.name));
    if (residual.length > 0) throw new Error(`Subagent task-management deny set violated: ${residual.map((item) => item.name).join(", ")}`);
  }

  if (input.subagentDefinition) {
    const allowedNames = new Set(applyAgentDefinitionToolPolicy(
      descriptors.map((descriptor) => descriptor.definition),
      input.subagentDefinition
    ).map((tool) => tool.name));
    descriptors = descriptors.filter((descriptor) => allowedNames.has(descriptor.name));
  }

  return descriptors;
}

/** 审批豁免键不得随定义自声明存活：runtimeWrapped 短路复用的定义同样剥离（#711 review 第四轮） */
function stripDeclaredDelegatesPermission(tool: ToolDefinition): ToolDefinition {
  const meta = (tool as { runtimeMetadata?: Record<string, unknown> }).runtimeMetadata;
  if (!meta || meta.delegatesPermission === undefined) return tool;
  const { delegatesPermission: _stripped, ...rest } = meta;
  return {
    ...tool,
    runtimeMetadata: rest,
  } as ToolDefinition;
}

function materializeRuntimeTools(input: {
  descriptors: LumeToolDescriptor[];
  threadId: string;
  cwd: string;
}): ToolDefinition[] {
  return input.descriptors.map((descriptor) => {
    // 已盖章的定义直接复用（但豁免键仍剥离）；其余统一包 wrapper——包括
    // AskUserQuestion，单载体化后它同样需要 runtimeMetadata 供 canUseTool 组装（#541）
    const runtimeTool =
      (descriptor.definition as { runtimeMetadata?: Record<string, unknown> }).runtimeMetadata?.runtimeWrapped === true
        ? stripDeclaredDelegatesPermission(descriptor.definition)
        : wrapToolDefinitionWithRuntimePolicies({
            descriptor,
            threadId: input.threadId,
            cwd: input.cwd,
            fileLedger: getRuntimeFileAccessLedger()
          });
    return runtimeTool;
  });
}

function applyAgentDefinitionToolPolicy(
  tools: ToolDefinition[],
  agentDefinition: AgentDefinition
): ToolDefinition[] {
  let filtered = tools;
  if (agentDefinition.tools && agentDefinition.tools.length > 0) {
    filtered = filterTools(filtered, agentDefinition.tools);
  }
  if (agentDefinition.disallowedTools && agentDefinition.disallowedTools.length > 0) {
    filtered = filterTools(filtered, undefined, agentDefinition.disallowedTools);
  }
  return filtered;
}

function validateCommandPluginManifest(path: string, pluginName: string): {
  ok: boolean;
  diagnostics: ToolRuntimeDiagnostic[];
} {
  const manifestPath = join(path, "plugin.json");
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      diagnostics: [{
        pluginName,
        path,
        severity: "warning",
        reason: "Lume plugin v1 only loads command manifests; plugin.json is missing."
      }]
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
    const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
    const commandTools = tools.filter((tool) => isCommandToolManifest(tool));
    if (commandTools.length === 0) {
      return {
        ok: false,
        diagnostics: [{
          pluginName,
          path,
          severity: "warning",
          reason: "Lume plugin v1 requires at least one command tool in plugin.json."
        }]
      };
    }
    if (tools.length !== commandTools.length) {
      return {
        ok: false,
        diagnostics: [{
          pluginName,
          path,
          severity: "warning",
          reason: "Lume plugin v1 does not load non-command plugin tools."
        }]
      };
    }
    const diagnostics: ToolRuntimeDiagnostic[] = [];
    if (typeof parsed.entry === "string") {
      diagnostics.push({
        pluginName,
        path,
        severity: "info",
        reason: "Lume ignored plugin entry/module code and loaded command tools only."
      });
    }
    return { ok: true, diagnostics };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{
        pluginName,
        path,
        severity: "error",
        reason: `Failed to parse plugin.json: ${error instanceof Error ? error.message : String(error)}`
      }]
    };
  }
}

function isCommandToolManifest(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === "string" &&
    typeof record.description === "string" &&
    typeof record.command === "string";
}
