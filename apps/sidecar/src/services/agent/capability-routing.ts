import type { AgentToolPolicy, SkillMeta } from "@lume/shared";
import { canonicalizeAgentToolName } from "@lume/shared";

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
    .filter((skill) => skill.disableModelInvocation !== true)
    .flatMap((skill) => [
      skill.slug,
      skill.name,
      skill.description ?? "",
      skill.whenToUse ?? "",
      skill.argumentHint ?? ""
    ])
    .join(" ")
    .toLowerCase();
}

function containsAny(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern));
}

function hasExplicitSkillInvocation(message: string, skills: SkillMeta[]): boolean {
  const invocableSkills = skills.filter((skill) => skill.disableModelInvocation !== true);
  if (invocableSkills.length === 0) return false;

  const pattern = /\$([\w-]+)(?::([\w-]+))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(message)) !== null) {
    const pluginName = match[1]?.toLowerCase();
    const skillSlug = match[2]?.toLowerCase();
    if (!pluginName) continue;
    const namespacedSlug = skillSlug ? `${pluginName}:${skillSlug}` : undefined;
    if (invocableSkills.some((skill) => {
      const slug = skill.slug.toLowerCase();
      const name = skill.name.toLowerCase();
      if (namespacedSlug) {
        return slug === namespacedSlug || name === namespacedSlug;
      }
      return slug === pluginName || slug.startsWith(`${pluginName}:`) || name === pluginName;
    })) {
      return true;
    }
  }
  return false;
}

export function resolvePreferredCapabilityRoute(input: CapabilityRoutingInput): CapabilityRoutingDecision {
  const lanes = inferCapabilityLanes(input.availableTools);
  const laneSet = new Set(lanes);
  const message = (input.userMessage ?? "").trim().toLowerCase();
  const skillText = buildSkillText(input.loadedSkills ?? []);

  if (!message) {
    const fallbackLane = laneSet.has("raw-tools") ? "raw-tools" : null;
    return {
      lanes,
      preferredLane: fallbackLane,
      reason: fallbackLane
        ? "no user message available; default to direct tools"
        : lanes.length > 0
          ? "no user message available; no capability lane is preferred"
          : "no capability lanes available"
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
  if (laneSet.has("skills") && hasExplicitSkillInvocation(message, input.loadedSkills ?? [])) {
    return {
      lanes,
      preferredLane: "skills",
      reason: "explicit skill invocation matched a loaded skill"
    };
  }
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
    "以前",
    "上次",
    "刚才",
    "接着上次",
    "我们现在",
    "现在干嘛",
    "现在在干嘛",
    "在做什么",
    "做到哪",
    "当前进展",
    "当前状态",
    "还差什么",
    "接下来",
    "what we are doing",
    "where we are",
    "current progress",
    "shared work state"
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

  if (laneSet.has("raw-tools")) {
    return {
      lanes,
      preferredLane: "raw-tools",
      reason: "no specific capability lane matched; use direct tools"
    };
  }

  if (laneSet.has("skills")) {
    return {
      lanes,
      preferredLane: null,
      reason: "skills are available but no loaded skill clearly matched the request"
    };
  }

  return {
    lanes,
    preferredLane: lanes[0] ?? null,
    reason: lanes.length > 0 ? "fallback to first available capability lane" : "no capability lanes available"
  };
}
