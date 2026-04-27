import { createHash } from "node:crypto";
import type { MemoryItem, MemoryKind, MemoryScope, MemorySource } from "@lume/shared";

const SECTION_KIND_MAP: Record<string, MemoryKind> = {
  "current state": "summary",
  "workspace brief": "summary",
  "important decisions": "decision",
  "decisions": "decision",
  "preferences": "preference",
  "user preferences": "preference",
  "user preferences in this workspace": "preference",
  "facts": "fact",
  "episodes": "episode",
  "lessons": "lesson",
  "milestones": "milestone",
  "artifacts": "artifact"
};

interface MarkdownSection {
  title: string;
  kind: MemoryKind;
  startLine: number;
  lines: string[];
}

export interface ParsedMemoryItemInput {
  workspaceSlug: string;
  sourcePath: string;
  source: MemorySource;
  scope: MemoryScope;
  kind: MemoryKind;
  title?: string;
  content: string;
  confidence: number;
  importance: 1 | 2 | 3 | 4 | 5;
  id: string;
}

function normalizeHeading(value: string): string {
  return value
    .replace(/^\d{4}-\d{2}-\d{2}\s*/, "")
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function inferKindFromHeading(heading: string): MemoryKind | null {
  const normalized = normalizeHeading(heading);
  if (SECTION_KIND_MAP[normalized]) return SECTION_KIND_MAP[normalized];
  for (const [key, kind] of Object.entries(SECTION_KIND_MAP)) {
    if (normalized.includes(key)) return kind;
  }
  return null;
}

function inferScope(path: string, kind: MemoryKind): MemoryScope {
  if (path === "WORKSPACE.md" || kind === "summary" || kind === "decision") return "workspace";
  if (path === "MEMORY.md" || kind === "preference" || kind === "fact" || kind === "lesson") return "workspace";
  return "session";
}

function inferSource(path: string, fallback: "memory" | "session"): MemorySource {
  if (fallback === "session") return "session";
  if (path === "WORKSPACE.md" || path === "MEMORY.md" || path.startsWith("memory/")) return "memory";
  return "file";
}

function normalizeContentLine(line: string): string {
  return line
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+[.)]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isUsefulContent(value: string): boolean {
  if (!value || value.length < 8) return false;
  if (/^\.\.\.?$/.test(value)) return false;
  if (/^describe\b/i.test(value)) return false;
  return true;
}

function stableMemoryId(input: {
  workspaceSlug: string;
  sourcePath: string;
  kind: MemoryKind;
  content: string;
}): string {
  return createHash("sha256")
    .update(`${input.workspaceSlug}\n${input.sourcePath}\n${input.kind}\n${input.content}`)
    .digest("hex")
    .slice(0, 32);
}

function sectionContentItems(section: MarkdownSection): string[] {
  const bullets: string[] = [];
  const paragraphs: string[] = [];
  let currentParagraph: string[] = [];

  for (const rawLine of section.lines) {
    const line = rawLine.trim();
    if (!line) {
      if (currentParagraph.length > 0) {
        paragraphs.push(currentParagraph.join(" "));
        currentParagraph = [];
      }
      continue;
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(rawLine)) {
      if (currentParagraph.length > 0) {
        paragraphs.push(currentParagraph.join(" "));
        currentParagraph = [];
      }
      bullets.push(normalizeContentLine(rawLine));
      continue;
    }

    currentParagraph.push(normalizeContentLine(rawLine));
  }

  if (currentParagraph.length > 0) {
    paragraphs.push(currentParagraph.join(" "));
  }

  return [...bullets, ...paragraphs]
    .map(normalizeContentLine)
    .filter(isUsefulContent);
}

export function parseMarkdownMemoryItems(input: {
  workspaceSlug: string;
  path: string;
  content: string;
  source: "memory" | "session";
}): ParsedMemoryItemInput[] {
  const sections: MarkdownSection[] = [];
  let current: MarkdownSection | null = null;
  const lines = input.content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const title = heading[2]?.trim() ?? "";
      const kind = inferKindFromHeading(title);
      if (kind) {
        current = {
          title,
          kind,
          startLine: index + 1,
          lines: []
        };
        sections.push(current);
      } else {
        current = null;
      }
      continue;
    }

    current?.lines.push(line);
  }

  const items: ParsedMemoryItemInput[] = [];
  for (const section of sections) {
    const source = inferSource(input.path, input.source);
    const scope = inferScope(input.path, section.kind);
    for (const content of sectionContentItems(section)) {
      items.push({
        workspaceSlug: input.workspaceSlug,
        sourcePath: input.path,
        source,
        scope,
        kind: section.kind,
        title: section.title,
        content,
        confidence: 0.85,
        importance: section.kind === "decision" || section.kind === "preference" ? 4 : 3,
        id: stableMemoryId({
          workspaceSlug: input.workspaceSlug,
          sourcePath: input.path,
          kind: section.kind,
          content
        })
      });
    }
  }

  return items;
}
