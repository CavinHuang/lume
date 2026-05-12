import type { ToolDefinition } from "@lume/agent-sdk";
import {
  getToolMetadata,
  inferToolMetadata
} from "../../pi-agent/tools/permissions/tool-metadata";
import type {
  LumeToolCapability,
  LumeToolDescriptorInput,
  LumeToolSideEffects,
  LumeToolSource
} from "./tool-types";

export function createToolDescriptorsFromDefinitions(
  definitions: ToolDefinition[],
  source: LumeToolSource
): LumeToolDescriptorInput[] {
  return definitions.map((definition) => {
    const legacyMetadata = getToolMetadata(definition.name) ?? inferToolMetadata(definition.name);
    return {
      name: definition.name,
      source,
      definition,
      metadata: {
        description: legacyMetadata.description,
        category: legacyMetadata.category,
        capability: inferCapability(definition.name, source, legacyMetadata.category),
        riskLevel: legacyMetadata.riskLevel,
        sideEffects: inferSideEffects(source, legacyMetadata.category),
        allowedInPlanMode: legacyMetadata.allowedInPlanMode ?? false,
        isReadOnly: legacyMetadata.category === "read" || legacyMetadata.category === "network",
        isConcurrencySafe: isConcurrencySafe(legacyMetadata.category),
        requiresApprovalByDefault: legacyMetadata.riskLevel !== "low"
      }
    };
  });
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
  if (source === "skill" || source === "plugin") return "skill";
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
