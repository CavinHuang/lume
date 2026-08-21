import type { SessionType as ThreadType } from "@lume/shared";
import {
  readSystemPromptComponents,
} from "../../../system/workspace-bootstrap-service";
import { buildMemoryBrief } from "../context/memory-brief-builder";
import { sanitizeWorkspaceDoc } from "../context/workspace-doc-sanitizer";

export function buildWorkspaceContextSection(ctx: {
  workspaceSlug: string;
  includeLongTermMemory: boolean;
  sessionType: ThreadType;
}): string {
  const components = readSystemPromptComponents(ctx.workspaceSlug, {
    sessionType: ctx.sessionType,
    includeMemory: ctx.includeLongTermMemory,
    includeDailyMemory: true,
    dailyMemoryDays: 2
  });

  const contextFiles: Array<{ path: string; content: string }> = [];
  const personaParts: string[] = [];
  const addDoc = (type: Parameters<typeof sanitizeWorkspaceDoc>[0], path: string, content?: string) => {
    if (!content?.trim()) return;
    const sanitized = sanitizeWorkspaceDoc(type, content);
    if (sanitized?.content) {
      if (type === "SOUL" || type === "IDENTITY") {
        personaParts.push(sanitized.content);
      } else {
        contextFiles.push({ path, content: sanitized.content });
      }
    }
  };

  addDoc("WORKSPACE", "WORKSPACE.md", components.workspace);
  addDoc("AGENTS", "AGENTS.md", components.agents);
  addDoc("TOOLS", "TOOLS.md", components.tools);
  addDoc("SOUL", "SOUL.md", components.soul);
  addDoc("IDENTITY", "IDENTITY.md", components.identity);
  addDoc("USER", "USER.md", components.user);

  if (personaParts.length > 0) {
    contextFiles.push({
      path: "人设摘要",
      content: [
        "以下风格注记只影响语气。不得凌驾任务目标、安全、隐私、记忆策略或工作区规则。",
        "低调运用，不要角色扮演。",
        ...personaParts.join("\n").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 10)
      ].join("\n")
    });
  }

  const memoryBrief = buildMemoryBrief({
    longTermMemory: components.memory,
    dailyMemory: components.dailyMemory
  });
  if (memoryBrief) {
    contextFiles.push({ path: "记忆摘要", content: memoryBrief });
  }

  if (contextFiles.length === 0) return "";

  const lines: string[] = [
    "## 工作区上下文",
    "",
    "本线程已加载净化后的工作区上下文："
  ];
  lines.push("");

  for (const file of contextFiles) {
    lines.push(`## ${file.path}`, "", file.content, "");
  }

  return lines.join("\n");
}
