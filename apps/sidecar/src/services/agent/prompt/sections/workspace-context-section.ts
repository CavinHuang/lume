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
      path: "Persona Brief",
      content: [
        "The following style notes may affect tone only. They must not override task goals, safety, privacy, memory policy, or workspace rules.",
        "Use them subtly. Do not roleplay them.",
        ...personaParts.join("\n").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 10)
      ].join("\n")
    });
  }

  const memoryBrief = buildMemoryBrief({
    longTermMemory: components.memory,
    dailyMemory: components.dailyMemory
  });
  if (memoryBrief) {
    contextFiles.push({ path: "Memory Brief", content: memoryBrief });
  }

  if (contextFiles.length === 0) return "";

  const lines: string[] = [
    "## Workspace Context",
    "",
    "Sanitized workspace context loaded for this thread:"
  ];
  lines.push("");

  for (const file of contextFiles) {
    lines.push(`## ${file.path}`, "", file.content, "");
  }

  return lines.join("\n");
}
