import type { LumeGuardrail, LumeGuardrailContext, LumeGuardrailResult } from "./guardrail-types";

export interface RunToolInputGuardrailsInput {
  toolName: string;
  input: unknown;
  context: LumeGuardrailContext;
}

export class LumeGuardrailRunner {
  constructor(private readonly guardrails: LumeGuardrail[] = []) {}

  async runToolInputGuardrails(input: RunToolInputGuardrailsInput): Promise<LumeGuardrailResult> {
    for (const guardrail of this.guardrails) {
      if (guardrail.scope !== "tool_input") continue;
      const result = await guardrail.run(input, {
        ...input.context,
        toolName: input.toolName
      });
      if (result.behavior !== "allow") {
        return result;
      }
    }
    return { behavior: "allow" };
  }
}
