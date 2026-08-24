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

export function estimateToolSchemaTokens(tools: ToolDefinition[]): number {
  return tools.reduce(
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
}
