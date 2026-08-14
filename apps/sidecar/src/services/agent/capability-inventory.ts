import { canonicalizeAgentToolName } from "@lume/shared";

export type CapabilityLane = "skills" | "browser" | "memory" | "web" | "coding" | "raw-tools";

function normalizeToolNames(inputTools?: string[]): Set<string> {
  return new Set((inputTools ?? []).map((item) => canonicalizeAgentToolName(item)).filter(Boolean));
}

export function inferCapabilityLanes(inputTools?: string[]): CapabilityLane[] {
  const normalized = normalizeToolNames(inputTools);
  const lanes: CapabilityLane[] = [];
  if (normalized.has("skill")) lanes.push("skills");
  if (normalized.has("browser")) lanes.push("browser");
  if (
    normalized.has("memory.search")
    || normalized.has("memory.read")
    || normalized.has("memory.remember")
  ) {
    lanes.push("memory");
  }
  if (normalized.has("web_search") || normalized.has("web_fetch")) lanes.push("web");

  const hasRepositoryTools = normalized.has("read")
    || normalized.has("write")
    || normalized.has("edit")
    || normalized.has("bash")
    || normalized.has("find")
    || normalized.has("grep")
    || normalized.has("ls");
  if (hasRepositoryTools) lanes.push("raw-tools");
  if (
    (normalized.has("write") || normalized.has("edit"))
    && (normalized.has("read") || normalized.has("grep") || normalized.has("bash"))
  ) {
    lanes.push("coding");
  }
  return lanes;
}
