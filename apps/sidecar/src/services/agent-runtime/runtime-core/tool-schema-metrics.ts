import { createHash } from "node:crypto";
import type { ToolDefinition } from "@lume/agent-sdk";

/** 工具 schema 指纹与体积估算(纯函数,#297 自 run-tools 按域拆分)。 */

export function fingerprintToolSchema(tools: ToolDefinition[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      ),
    )
    .digest("hex");
}

// #527-13：同一 toolset 实例在一次 run 内会被多处分别估算
// （assembleSessionContext 与 Impl 配置对象），按数组实例 memo 免重复全量
// JSON.stringify。WeakMap 键为实例：toolset 重建则自然重算，无过期问题。
const tokenEstimateCache = new WeakMap<ToolDefinition[], number>();

export function estimateToolSchemaTokens(tools: ToolDefinition[]): number {
  const cached = tokenEstimateCache.get(tools);
  if (cached !== undefined) {
    return cached;
  }
  const total = tools.reduce(
    (sum, tool) =>
      sum +
      Math.ceil(
        (tool.name.length +
          tool.description.length +
          JSON.stringify(tool.inputSchema ?? {}).length) /
          4,
      ),
    0,
  );
  tokenEstimateCache.set(tools, total);
  return total;
}
