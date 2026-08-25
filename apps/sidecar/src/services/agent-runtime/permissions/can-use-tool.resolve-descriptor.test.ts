import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@lume/agent-sdk";
import { resolveRuntimeDescriptor } from "./can-use-tool";

function toolWithMeta(runtimeMetadata: Record<string, unknown>): ToolDefinition {
  return {
    name: "Probe",
    description: "probe",
    inputSchema: { type: "object", properties: {} },
    runtimeMetadata,
    async call() {
      return { type: "tool_result", tool_use_id: "", content: "ok" };
    },
  } as ToolDefinition;
}

describe("resolveRuntimeDescriptor (#711 review)", () => {
  test("illegal source value falls back to sdk instead of being trusted", () => {
    const descriptor = resolveRuntimeDescriptor(toolWithMeta({
      source: "not-a-source",
      category: "read",
      capability: "filesystem",
      riskLevel: "low",
      sideEffects: "none",
    }));
    expect(descriptor?.source).toBe("sdk");
  });

  test("missing permission-critical fields stay undefined rather than trusting arbitrary values", () => {
    const descriptor = resolveRuntimeDescriptor(toolWithMeta({}));
    expect(descriptor?.metadata.requiresApprovalByDefault).toBeUndefined();
    expect(descriptor?.metadata.allowedInPlanMode).toBe(false);
    expect(descriptor?.metadata.isReadOnly).toBe(false);
    // canonicalName 兜底重算
    expect(descriptor?.canonicalName).toBe("probe");
  });
});
