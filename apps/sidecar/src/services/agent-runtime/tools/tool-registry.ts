import { canonicalizeAgentToolName } from "@lume/shared";
import type {
  LumeToolDescriptor,
  LumeToolDescriptorInput,
  LumeToolMetadata,
  LumeToolSource
} from "./tool-types";

export class ToolRegistry {
  private readonly tools = new Map<string, LumeToolDescriptor>();

  register(tool: LumeToolDescriptorInput): void {
    const canonicalName = tool.canonicalName ?? canonicalizeAgentToolName(tool.name);
    this.tools.set(canonicalName, {
      name: tool.name,
      canonicalName,
      source: tool.source,
      definition: tool.definition,
      metadata: normalizeToolMetadata(tool.source, tool.metadata)
    });
  }

  registerMany(tools: LumeToolDescriptorInput[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  list(): LumeToolDescriptor[] {
    return Array.from(this.tools.values());
  }

  get(name: string): LumeToolDescriptor | undefined {
    return this.tools.get(canonicalizeAgentToolName(name));
  }
}

function normalizeToolMetadata(
  source: LumeToolSource,
  metadata: Partial<LumeToolMetadata> | undefined
): LumeToolMetadata {
  const defaults = defaultMetadataForSource(source);
  return {
    ...defaults,
    ...metadata
  };
}

function defaultMetadataForSource(source: LumeToolSource): LumeToolMetadata {
  if (source === "mcp" || source === "plugin") {
    return {
      category: "control",
      capability: source === "mcp" ? "mcp" : "skill",
      riskLevel: "medium",
      sideEffects: "external",
      allowedInPlanMode: false,
      isReadOnly: false,
      isConcurrencySafe: false,
      requiresApprovalByDefault: true
    };
  }
  return {
    category: "control",
    capability: "skill",
    riskLevel: "medium",
    sideEffects: "external",
    allowedInPlanMode: false,
    isReadOnly: false,
    isConcurrencySafe: false,
    requiresApprovalByDefault: true
  };
}
