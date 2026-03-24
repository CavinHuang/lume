import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { Static, TSchema } from "@sinclair/typebox";

export function adaptAgentToolToToolDefinition<
  TParams extends TSchema = TSchema,
  TDetails = unknown
>(
  tool: AgentTool<TParams, TDetails>
): ToolDefinition<TParams, TDetails> {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    async execute(
      toolCallId: string,
      params: Static<TParams>,
      signal,
      onUpdate
    ): Promise<AgentToolResult<TDetails>> {
      return tool.execute(toolCallId, params, signal, onUpdate);
    }
  };
}

export function adaptAgentToolsToToolDefinitions(
  tools: AgentTool[]
): ToolDefinition[] {
  return tools.map((tool) => adaptAgentToolToToolDefinition(tool));
}
