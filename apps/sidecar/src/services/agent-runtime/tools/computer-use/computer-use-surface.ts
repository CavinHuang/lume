import type { ComputerUseAgentSurface } from "@lume/shared";

export type ResolvedComputerUseSurface = Exclude<ComputerUseAgentSurface, "auto">;

export function resolveComputerUseSurface(input: {
  agentSurface?: ComputerUseAgentSurface;
  modelRef?: string;
  skyModelRefs?: string[];
  channelProvider?: string;
}): ResolvedComputerUseSurface {
  if (input.agentSurface === "sky" || input.agentSurface === "mcp") {
    return input.agentSurface;
  }
  if (input.modelRef && input.skyModelRefs?.includes(input.modelRef)) {
    return "sky";
  }
  return input.channelProvider === "openai" ? "sky" : "mcp";
}

export function filterComputerUseSkills<T extends { name: string }>(
  skills: T[],
  surface: ResolvedComputerUseSurface,
): T[] {
  return surface === "sky"
    ? skills
    : skills.filter((skill) => skill.name !== "computer-use:computer-use");
}
