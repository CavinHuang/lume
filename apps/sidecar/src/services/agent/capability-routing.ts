import type { AgentToolPolicy, SkillMeta } from "@lume/shared";

export type CapabilityLane = "skills" | "browser" | "memory" | "web" | "raw-tools";

export interface CapabilityRoutingInput {
  userMessage?: string;
  availableTools?: string[];
  loadedSkills?: SkillMeta[];
}

export interface CapabilityRoutingDecision {
  lanes: CapabilityLane[];
  preferredLane: CapabilityLane | null;
  reason: string;
}

export function resolveSoftToolPolicyForPreferredRoute(
  preferredLane: CapabilityLane | null
): AgentToolPolicy | undefined {
  if (preferredLane === "browser") {
    return {
      deny: ["web_search", "web_fetch"]
    };
  }
  if (preferredLane === "memory") {
    return {
      deny: ["web_search", "web_fetch"]
    };
  }
  if (preferredLane === "web") {
    return {
      deny: ["browser"]
    };
  }
  return undefined;
}

function normalizeToolNames(inputTools?: string[]): Set<string> {
  return new Set((inputTools ?? []).map((item) => item.trim().toLowerCase()).filter(Boolean));
}

export function inferCapabilityLanes(inputTools?: string[]): CapabilityLane[] {
  const normalized = normalizeToolNames(inputTools);
  const lanes: CapabilityLane[] = [];
  if (normalized.has("skill")) lanes.push("skills");
  if (normalized.has("browser")) lanes.push("browser");
  if (normalized.has("memory_search") || normalized.has("memory_get") || normalized.has("memory_save")) {
    lanes.push("memory");
  }
  if (normalized.has("web_search") || normalized.has("web_fetch")) {
    lanes.push("web");
  }
  if (
    normalized.has("read")
    || normalized.has("write")
    || normalized.has("edit")
    || normalized.has("bash")
    || normalized.has("find")
    || normalized.has("grep")
    || normalized.has("ls")
  ) {
    lanes.push("raw-tools");
  }
  return lanes;
}

function buildSkillText(skills: SkillMeta[]): string {
  return skills
    .flatMap((skill) => [skill.slug, skill.name, skill.description ?? ""])
    .join(" ")
    .toLowerCase();
}

function containsAny(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern));
}

export function resolvePreferredCapabilityRoute(input: CapabilityRoutingInput): CapabilityRoutingDecision {
  const lanes = inferCapabilityLanes(input.availableTools);
  const laneSet = new Set(lanes);
  const message = (input.userMessage ?? "").trim().toLowerCase();
  const skillText = buildSkillText(input.loadedSkills ?? []);

  if (!message) {
    return {
      lanes,
      preferredLane: lanes[0] ?? null,
      reason: lanes.length > 0 ? "fallback to first available capability lane" : "no capability lanes available"
    };
  }

  const wantsLowLevelControl = containsAny(message, [
    "bash",
    "shell",
    "terminal",
    "command",
    "命令",
    "终端",
    "手动",
    "底层",
    "raw tool",
    "low-level"
  ]);
  if (wantsLowLevelControl && laneSet.has("raw-tools")) {
    return {
      lanes,
      preferredLane: "raw-tools",
      reason: "user explicitly asked for low-level/manual tool control"
    };
  }

  const skillLikelyMatch = laneSet.has("skills")
    && skillText.length > 0
    && message.split(/[\s,.;:!?，。；：！？()（）]+/).filter((token) => token.length >= 3)
      .some((token) => skillText.includes(token));
  if (skillLikelyMatch) {
    return {
      lanes,
      preferredLane: "skills",
      reason: "loaded skill metadata overlaps with the user request"
    };
  }

  const browserIntent = containsAny(message, [
    "browser",
    "tab",
    "page",
    "current page",
    "profile",
    "open page",
    "浏览器",
    "页面",
    "当前页",
    "标签页"
  ]);
  if (browserIntent && laneSet.has("browser")) {
    return {
      lanes,
      preferredLane: "browser",
      reason: "request implies browser/session continuity"
    };
  }

  const memoryIntent = containsAny(message, [
    "remember",
    "memory",
    "preference",
    "history",
    "previous",
    "before",
    "之前",
    "偏好",
    "历史",
    "记忆",
    "以前"
  ]);
  if (memoryIntent && laneSet.has("memory")) {
    return {
      lanes,
      preferredLane: "memory",
      reason: "request refers to prior decisions, memory, or continuity"
    };
  }

  const webIntent = containsAny(message, [
    "latest",
    "news",
    "search",
    "web",
    "website",
    "url",
    "google",
    "最新",
    "搜索",
    "网页",
    "网站",
    "链接"
  ]);
  if (webIntent && laneSet.has("web")) {
    return {
      lanes,
      preferredLane: "web",
      reason: "request implies public web retrieval"
    };
  }

  if (laneSet.has("skills")) {
    return {
      lanes,
      preferredLane: "skills",
      reason: "skills lane is available and should be preferred before raw tools by default"
    };
  }

  if (laneSet.has("raw-tools")) {
    return {
      lanes,
      preferredLane: "raw-tools",
      reason: "no higher-level capability lane matched; use direct tools"
    };
  }

  return {
    lanes,
    preferredLane: lanes[0] ?? null,
    reason: lanes.length > 0 ? "fallback to first available capability lane" : "no capability lanes available"
  };
}
