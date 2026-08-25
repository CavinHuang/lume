import type { ToolDefinition } from "@lume/agent-sdk";
import {
  getToolMetadata,
  inferToolMetadata
} from "./tool-metadata";
import {
  LUME_TOOL_SOURCES,
  LumeToolCapability,
  LumeToolDescriptorInput,
  LumeToolMetadata,
  LumeToolSideEffects,
  LumeToolSource
} from "./tool-types";

export function createToolDescriptorsFromDefinitions(
  definitions: ToolDefinition[],
  source: LumeToolSource
): LumeToolDescriptorInput[] {
  return definitions.map((definition) => {
    const baseMetadata = getToolMetadata(definition.name) ?? inferToolMetadata(definition.name);
    const runtimeMetadata = readRuntimeMetadata(definition);
    const resolvedSource = readRuntimeSource(definition) ?? inferRuntimeSource(definition.name, source);
    // 定义体的显式 isReadOnly 优先于类别推断（#537）：defineTool 会把布尔
    // 规范化为函数形态，这里两种形态都认；动态求值失败时回退推断
    const definitionIsReadOnly = readDeclaredReadOnly(definition);
    if (resolvedSource === "mcp" || resolvedSource === "plugin") {
      return {
        name: definition.name,
        source: resolvedSource,
        definition,
        metadata: {
          description: baseMetadata.description,
          // 与 sdk 分支对称（review）：定义体显式 isReadOnly 同样生效；无声明
          // 时维持原状不引入推断（plugin 仍可经 runtimeMetadata 覆盖）
          ...(definitionIsReadOnly !== undefined ? { isReadOnly: definitionIsReadOnly } : {}),
          ...runtimeMetadata
        }
      };
    }
    return {
      name: definition.name,
      source: resolvedSource,
      definition,
      metadata: {
        description: baseMetadata.description,
        category: baseMetadata.category,
        capability: inferCapability(definition.name, resolvedSource, baseMetadata.category),
        riskLevel: baseMetadata.riskLevel,
        sideEffects: inferSideEffects(resolvedSource, baseMetadata.category),
        allowedInPlanMode: baseMetadata.allowedInPlanMode ?? false,
        isReadOnly: definitionIsReadOnly ?? (baseMetadata.category === "read" || baseMetadata.category === "network"),
        isConcurrencySafe: isConcurrencySafe(baseMetadata.category),
        requiresApprovalByDefault: baseMetadata.riskLevel !== "low",
        ...runtimeMetadata
      }
    };
  });
}

function readRuntimeMetadata(definition: ToolDefinition): Partial<LumeToolMetadata> {
  const metadata = readRuntimeMetadataRecord(definition);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }
  const raw = metadata as Record<string, unknown>;
  const result: Partial<LumeToolMetadata> = {};
  if (typeof raw.title === "string") result.title = raw.title;
  if (typeof raw.description === "string") result.description = raw.description;
  if (isCategory(raw.category)) result.category = raw.category;
  if (isCapability(raw.capability)) result.capability = raw.capability;
  if (isRiskLevel(raw.riskLevel)) result.riskLevel = raw.riskLevel;
  if (isSideEffects(raw.sideEffects)) result.sideEffects = raw.sideEffects;
  if (typeof raw.allowedInPlanMode === "boolean") result.allowedInPlanMode = raw.allowedInPlanMode;
  if (typeof raw.isReadOnly === "boolean") result.isReadOnly = raw.isReadOnly;
  if (typeof raw.isConcurrencySafe === "boolean") result.isConcurrencySafe = raw.isConcurrencySafe;
  if (typeof raw.requiresWorkspace === "boolean") result.requiresWorkspace = raw.requiresWorkspace;
  if (typeof raw.requiresNetwork === "boolean") result.requiresNetwork = raw.requiresNetwork;
  if (typeof raw.requiresApprovalByDefault === "boolean") result.requiresApprovalByDefault = raw.requiresApprovalByDefault;
  if (isRecord(raw.payloadPolicy)) result.payloadPolicy = raw.payloadPolicy as LumeToolMetadata["payloadPolicy"];
  if (isRecord(raw.resultPolicy)) result.resultPolicy = raw.resultPolicy as LumeToolMetadata["resultPolicy"];
  if (isRecord(raw.executionPolicy)) result.executionPolicy = raw.executionPolicy as LumeToolMetadata["executionPolicy"];
  return result;
}

function readRuntimeSource(definition: ToolDefinition): LumeToolSource | undefined {
  const source = readRuntimeMetadataRecord(definition)?.source;
  // 单一源判定（#711 review 第四轮）：枚举增值只改 LUME_TOOL_SOURCES 一处
  if (typeof source === "string" && (LUME_TOOL_SOURCES as readonly string[]).includes(source)) {
    return source as LumeToolSource;
  }
  return undefined;
}

function readRuntimeMetadataRecord(definition: ToolDefinition): Record<string, unknown> | undefined {
  const metadata = (definition as { runtimeMetadata?: unknown }).runtimeMetadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : undefined;
}

function readDeclaredReadOnly(definition: ToolDefinition): boolean | undefined {
  const value = (definition as { isReadOnly?: unknown }).isReadOnly;
  if (typeof value === "boolean") return value;
  if (typeof value !== "function") return undefined;
  try {
    // 依赖入参的动态只读函数无参求值可能得到 undefined——视为无法确定，回退推断
    const result = (value as () => unknown)();
    return typeof result === "boolean" ? result : undefined;
  } catch {
    return undefined;
  }
}

function inferRuntimeSource(toolName: string, fallback: LumeToolSource): LumeToolSource {
  const normalized = toolName.trim().toLowerCase();
  if (normalized.startsWith("mcp__")) return "mcp";
  if (normalized.startsWith("memory.") || normalized.startsWith("memory_")) return "memory";
  if (normalized.startsWith("automation_") || normalized.startsWith("cron_")) return "automation";
  return fallback;
}

function inferCapability(
  toolName: string,
  source: LumeToolSource,
  category: string
): LumeToolCapability {
  if (source === "memory") return "memory";
  if (source === "automation") return "automation";
  if (source === "plan" || source === "task") return "planning";
  if (source === "mcp") return "mcp";
  if (source === "skill") return "skill";
  if (source === "plugin") return "plugin";
  const normalized = toolName.trim().toLowerCase();
  if (normalized.includes("web")) return "web";
  if (normalized === "bash") return "shell";
  if (normalized.includes("agent") || normalized.includes("task")) return "subagent";
  if (category === "execute") return "shell";
  return "filesystem";
}

function inferSideEffects(source: LumeToolSource, category: string): LumeToolSideEffects {
  if (source === "mcp" || source === "plugin") return "external";
  if (category === "read") return "local_read";
  if (category === "write") return "local_write";
  if (category === "network") return "network";
  if (category === "execute") return "process";
  return "none";
}

function isConcurrencySafe(category: string): boolean {
  return category === "read" || category === "network";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isCategory(value: unknown): value is LumeToolMetadata["category"] {
  return value === "read" || value === "write" || value === "execute" || value === "control" || value === "network";
}

export function isCapability(value: unknown): value is LumeToolCapability {
  return value === "filesystem" ||
    value === "shell" ||
    value === "web" ||
    value === "memory" ||
    value === "automation" ||
    value === "planning" ||
    value === "subagent" ||
    value === "mcp" ||
    value === "skill" ||
    value === "plugin" ||
    value === "external";
}

export function isRiskLevel(value: unknown): value is LumeToolMetadata["riskLevel"] {
  return value === "low" || value === "medium" || value === "high";
}

export function isSideEffects(value: unknown): value is LumeToolSideEffects {
  return value === "none" ||
    value === "local_read" ||
    value === "local_write" ||
    value === "network" ||
    value === "process" ||
    value === "external";
}
