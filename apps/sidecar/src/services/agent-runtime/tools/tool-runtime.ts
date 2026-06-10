import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { filterTools, type AgentDefinition, type AgentOptions, type ToolDefinition } from "@lume/agent-sdk";
import type { AgentSendInput } from "@lume/shared";
import { getEffectiveLumeConfig } from "../../system/lume-config-service";
import { SidecarPluginManager } from "../plugins/plugin-manager.js";
import { ToolRegistry } from "./tool-registry";
import { ToolResolver } from "./tool-resolver";
import { createToolDescriptorsFromDefinitions } from "./tool-source";
import { getRuntimeFileAccessLedger } from "./file-access-ledger";
import { wrapToolDefinitionWithRuntimePolicies } from "./tool-runtime-wrapper";
import { createLogger } from "../../infra/logger";
import {
  setRuntimeToolDescriptors
} from "./tool-descriptor-session";
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

export interface ResolveCommandPluginSpecsResult {
  specs: NonNullable<AgentOptions["plugins"]>;
  diagnostics: ToolRuntimeDiagnostic[];
}

const log = createLogger("plugin-tool-runtime");

export class ToolRuntime {
  static build(input: ToolRuntimeBuildInput): ToolRuntimeBuildResult {
    const descriptors = resolveDescriptors(input);
    const tools = materializeRuntimeTools({
      descriptors,
      threadId: input.sessionId,
      cwd: input.cwd
    });
    setRuntimeToolDescriptors(input.sessionId, descriptors);

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
    cwd: string;
    sessionId: string;
    permissionMode?: AgentSendInput["permissionMode"];
    messageMetadata?: Record<string, unknown>;
    policyInput: ResolveEffectiveToolPolicyInput;
  }): ToolDefinition[] {
    const descriptors = resolveDescriptors({
      cwd: input.cwd,
      sessionId: input.sessionId,
      permissionMode: input.permissionMode,
      messageMetadata: input.messageMetadata,
      policyInput: input.policyInput,
      groups: [{ source: "sdk", tools: input.tools }]
    });
    setRuntimeToolDescriptors(input.sessionId, descriptors);
    return materializeRuntimeTools({
      descriptors,
      threadId: input.sessionId,
      cwd: input.cwd
    });
  }

  static resolveCommandPluginSpecs(input: {
    cwd: string;
    workspaceSlug?: string;
  }): ResolveCommandPluginSpecsResult {
    const config = getEffectiveLumeConfig(input.workspaceSlug).plugins;
    const enabledList = config?.enabled ?? [];
    const directories = config?.directories ?? [];

    // Build plugin roots: global + cwd-local + configured extra dirs
    const globalRoot = join(homedir(), ".lume", "plugins");
    const cwdRoot = join(input.cwd, ".lume", "plugins");
    const allRoots = [globalRoot, cwdRoot, ...directories];

    // If user has configured enabled list, use it; otherwise scan all
    const effectiveEnabled = enabledList.length > 0 ? enabledList : undefined;

    const manager = new SidecarPluginManager();
    const resolved = manager.resolveEnabled({
      enabled: effectiveEnabled ?? [],
      directories: allRoots.slice(1), // pass non-default roots as extra directories
    });

    const specs: NonNullable<AgentOptions["plugins"]> = [];
    const diagnostics: ToolRuntimeDiagnostic[] = [];

    for (const plugin of resolved) {
      log.info("Plugin registered as command spec", {
        name: plugin.name,
        version: plugin.version,
        root: plugin.root,
        hooksOnly: plugin.manifest.lume?.hooksOnly ?? false,
      });
      specs.push({ name: plugin.name, path: plugin.root, kind: "command" });
    }

    log.info("Command plugin specs resolved", {
      cwd: input.cwd,
      workspaceSlug: input.workspaceSlug,
      totalSpecs: specs.length,
      names: specs.map((s) => s.name),
    });

    return { specs, diagnostics };
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
    descriptors = descriptors.filter((descriptor) => descriptor.name !== "Agent");
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

function materializeRuntimeTools(input: {
  descriptors: LumeToolDescriptor[];
  threadId: string;
  cwd: string;
}): ToolDefinition[] {
  return input.descriptors.map((descriptor) => {
    if (
      descriptor.canonicalName === "askuserquestion" ||
      (descriptor.definition as { runtimeMetadata?: Record<string, unknown> }).runtimeMetadata?.runtimeWrapped === true
    ) {
      return descriptor.definition;
    }
    return wrapToolDefinitionWithRuntimePolicies({
      descriptor,
      threadId: input.threadId,
      cwd: input.cwd,
      fileLedger: getRuntimeFileAccessLedger()
    });
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
