export type AgentRuntime = "pi_agent";

const DEFAULT_AGENT_RUNTIME: AgentRuntime = "pi_agent";

export function resolveAgentRuntime(rawValue = process.env.LUME_AGENT_RUNTIME): AgentRuntime {
  void rawValue;
  return DEFAULT_AGENT_RUNTIME;
}
