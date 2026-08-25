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

  test("missing or illegal required dimension fails closed to undefined descriptor (#711 review)", () => {
    // 四个必填维度任一非法 → 整体 undefined（descriptor_missing deny），不产出半残 descriptor
    expect(resolveRuntimeDescriptor(toolWithMeta({ category: "read" }))).toBeUndefined();
    expect(resolveRuntimeDescriptor(toolWithMeta({
      source: "sdk",
      category: "not-a-category",
      capability: "filesystem",
      riskLevel: "low",
      sideEffects: "none",
    }))).toBeUndefined();
  });

  test("empty runtimeMetadata fails closed instead of yielding a half-stamped descriptor", () => {
    // 空对象四必填维度全缺 → undefined（descriptor_missing deny），
    // 不产出 category/riskLevel 等为 undefined 的类型撒谎 descriptor
    expect(resolveRuntimeDescriptor(toolWithMeta({}))).toBeUndefined();
  });

  test("canonicalName falls back to canonicalize for fully stamped metadata", () => {
    const descriptor = resolveRuntimeDescriptor(toolWithMeta({
      source: "sdk",
      category: "read",
      capability: "filesystem",
      riskLevel: "low",
      sideEffects: "none",
      requiresApprovalByDefault: false,
      allowedInPlanMode: true,
      isReadOnly: true,
      isConcurrencySafe: true,
    }));
    expect(descriptor).toBeDefined();
    // canonicalName 兜底重算
    expect(descriptor?.canonicalName).toBe("probe");
  });
});
