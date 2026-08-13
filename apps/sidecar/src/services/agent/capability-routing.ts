import type { AgentToolPolicy, SkillMeta } from "@lume/shared";
import { canonicalizeAgentToolName } from "@lume/shared";

export type CapabilityLane = "skills" | "browser" | "memory" | "web" | "coding" | "raw-tools";

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
      deny: ["web_search", "web_fetch", "bash"]
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
  if (preferredLane === "coding" || preferredLane === "raw-tools") {
    return {
      deny: [
        "web_search",
        "web_fetch",
        "mcp__node_repl__*",
        "mcp__computer_use__*"
      ]
    };
  }
  return undefined;
}

function normalizeToolNames(inputTools?: string[]): Set<string> {
  return new Set((inputTools ?? []).map((item) => canonicalizeAgentToolName(item)).filter(Boolean));
}

export function inferCapabilityLanes(inputTools?: string[], userMessage?: string): CapabilityLane[] {
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
  if (
    (normalized.has("write") || normalized.has("edit"))
    && (normalized.has("read") || normalized.has("grep") || normalized.has("bash"))
    && hasCodingIntent(userMessage)
  ) {
    lanes.push("coding");
  }
  return lanes;
}

export function hasCodingIntent(value?: string): boolean {
  const message = (value ?? "").trim().toLowerCase();
  if (!message) return false;
  if (containsAny(message, [
    "code", "coding", "implement", "implementation", "refactor", "bug", "fix", "test", "build", "typecheck",
    "代码", "编程", "实现", "修复", "重构", "测试", "编译", "类型错误", "报错"
  ])) return true;
  const hasUiArtifact = containsAny(message, [
    "ui", "css", "layout", "component", "界面", "组件", "样式", "弹窗", "层级", "遮挡", "遮住"
  ]);
  const hasChangeOrDiagnosis = containsAny(message, [
    "change", "update", "adjust", "optimize", "issue", "problem",
    "修改", "调整", "优化", "改造", "问题", "异常"
  ]);
  return hasUiArtifact && hasChangeOrDiagnosis;
}

export function hasBrowserIntent(value?: string): boolean {
  const message = (value ?? "").trim().toLowerCase();
  if (containsAny(message, [
    "browser",
    "tab",
    "page",
    "current page",
    "profile",
    "open page",
    "浏览器",
    "页面",
    "当前页",
    "标签页",
    "地址栏",
    "搜索框"
  ])) return true;

  const wantsNavigation = containsAny(message, [
    "open",
    "visit",
    "navigate",
    "go to",
    "打开",
    "访问",
    "进入",
    "跳转",
    "前往"
  ]);
  const hasBrowserTarget = /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|cn|net|org|io)\b/i.test(message)
    || containsAny(message, [
      "百度",
      "谷歌",
      "google",
      "bing",
      "github",
      "网站",
      "网页",
      "网址"
    ]);
  return wantsNavigation && hasBrowserTarget;
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

export function resolvePreferredCapabilityRoute(input: CapabilityRoutingInput): CapabilityRoutingDecision {
  const lanes = inferCapabilityLanes(input.availableTools, input.userMessage);
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

  if (laneSet.has("coding")) {
    return {
      lanes,
      preferredLane: "coding",
      reason: "request implies a direct coding workflow"
    };
  }

  if (hasBrowserIntent(message) && laneSet.has("browser")) {
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
