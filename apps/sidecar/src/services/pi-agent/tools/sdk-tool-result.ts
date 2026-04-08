import { defineTool, type ToolDefinition, type ToolInputSchema } from "@lume/agent-sdk";

export function createSdkJsonResultTool(config: {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  isReadOnly?: boolean;
  isConcurrencySafe?: boolean;
  call: (input: Record<string, unknown>) => Promise<unknown>;
}): ToolDefinition {
  return defineTool({
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    isReadOnly: config.isReadOnly,
    isConcurrencySafe: config.isConcurrencySafe,
    async call(input) {
      const data = await config.call((input ?? {}) as Record<string, unknown>);
      return { data };
    }
  });
}
