import type { BootstrapFileType } from "@lume/shared";
import { stripFrontMatter } from "../../../system/workspace-template-utils";

export interface SanitizedWorkspaceDoc {
  type: BootstrapFileType;
  content: string;
}

const TEMPLATE_PATTERNS: Partial<Record<BootstrapFileType, RegExp[]>> = {
  AGENTS: [
    /^#\s*AGENTS\.md\s*-\s*Your Workspace$/i,
    /^This folder is home\. Treat it that way\.$/i,
    /^If `BOOTSTRAP\.md` exists/i,
    /^Before doing anything else:$/i,
    /^Read `SOUL\.md`/i,
    /^Read `USER\.md`/i,
    /^Read `memory\/YYYY-MM-DD\.md`/i,
    /^Don't ask permission\. Just do it\.$/i,
    /^You wake up fresh each session\./i,
    /^Text > Brain/i,
    /^The human rule:/i,
    /^Participate, don't dominate\.$/i,
    /^Skills provide your tools\./i,
    /^Default heartbeat prompt:/i,
    /^The goal: Be helpful without being annoying\./i,
    /^This is a starting point\./i
  ],
  USER: [
    /^#\s*USER\.md\s*-\s*About Your Human$/i,
    /^_Learn about the person you're helping/i,
    /^[-*]\s*(Name|What to call them|Pronouns|Timezone|Notes)\s*:\s*$/i,
    /^[-*]\s*\*\*(Name|What to call them|Pronouns|Timezone|Notes)\*\*\s*:\s*(?:_\(optional\)_)?\s*$/i,
    /^_\(What do they care about\?/i,
    /^_\(How human-like should you feel/i,
    /^The more you know, the better you can help\./i,
    /^But remember — you're learning about a person/i,
    /stable preferences/i,
    /collaboration style/i,
    /current long-running projects/i
  ],
  IDENTITY: [
    /^#\s*IDENTITY\.md\s*-\s*Who Am I\?$/i,
    /^_This is not just metadata\./i,
    /^Notes:$/i,
    /^[-*]\s*Save this file at the workspace root/i,
    /^[-*]\s*Keep this file in sync/i,
    /^[-*]\s*Strong persona is welcome/i,
    /describe .*identity/i,
    /avatar/i,
    /visual setting/i
  ],
  TOOLS: [
    /^#\s*TOOLS\.md\s*-\s*Local Notes$/i,
    /^Skills define _how_ tools work\./i,
    /^Things like:$/i,
    /^[-*]\s*(Camera names and locations|SSH hosts and aliases|Preferred voices for TTS|Speaker\/room names|Device nicknames|Anything environment-specific)\s*$/i,
    /^Add whatever helps you do your job\./i,
    /^Skills are shared\. Your setup is yours\./i,
    /^[-*]\s*(Tool|Tools|Notes|Command|Path)\s*:\s*$/i,
    /local tools/i,
    /environment notes/i
  ]
};

const DEFAULT_DOC_MARKERS: Partial<Record<BootstrapFileType, RegExp[]>> = {
  AGENTS: [
    /#\s*AGENTS\.md\s*-\s*Your Workspace/i,
    /## 💓 Heartbeats - Be Proactive!/i,
    /### 😊 React Like a Human!/i,
    /## Make It Yours/i
  ],
  TOOLS: [
    /#\s*TOOLS\.md\s*-\s*Local Notes/i,
    /## What Goes Here/i,
    /## Why Separate\?/i
  ],
  USER: [
    /#\s*USER\.md\s*-\s*About Your Human/i,
    /\*\*Name:\*\*\s*$/m,
    /The more you know, the better you can help/i
  ]
};

function stripTemplateNoise(type: BootstrapFileType, content: string): string {
  const patterns = TEMPLATE_PATTERNS[type] ?? [];
  return content
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (/^<!--[\s\S]*-->$/.test(trimmed)) return false;
      if (/^#{1,6}\s+[A-Z_ -]+\.md\s*$/i.test(trimmed)) return false;
      return !patterns.some((pattern) => pattern.test(trimmed));
    })
    .join("\n")
    .trim();
}

function compactDoc(type: BootstrapFileType, content: string): string {
  if (type !== "SOUL" && type !== "MEMORY" && type !== "IDENTITY") {
    return content.trim();
  }

  const meaningfulLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^#{1,6}\s+/.test(line));

  return meaningfulLines.slice(0, 12).join("\n").trim();
}

function isDefaultWorkspaceTemplate(type: BootstrapFileType, content: string): boolean {
  const markers = DEFAULT_DOC_MARKERS[type] ?? [];
  if (markers.length === 0) return false;
  return markers.every((marker) => marker.test(content));
}

export function sanitizeWorkspaceDoc(
  type: BootstrapFileType,
  content: string
): SanitizedWorkspaceDoc | null {
  const stripped = stripFrontMatter(content).trim();
  if (!stripped) return null;
  if (isDefaultWorkspaceTemplate(type, stripped)) return null;

  const withoutTemplateNoise = stripTemplateNoise(type, stripped);
  if (!withoutTemplateNoise) return null;

  return {
    type,
    content: compactDoc(type, withoutTemplateNoise)
  };
}
