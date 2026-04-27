import type { BootstrapFileType } from "@lume/shared";

const EMPTY_FIELD_PATTERN = /^[-*]\s*(?:\*\*)?[^:\n]+:(?:\*\*)?\s*(?:_\([^)]*\)_)?\s*$/;
const FRONTMATTER_PATTERN = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

const TEMPLATE_NOISE_PATTERNS: Array<RegExp> = [
  /^notes?:$/i,
  /^examples?:$/i,
  /^what goes here$/i,
  /^why separate\??$/i,
  /^the more you know/i,
  /^add whatever helps/i,
  /^learn about the person/i,
  /^this is not just metadata/i,
  /^save this file/i,
  /^for avatars/i,
  /^if the user wants/i,
  /^<!--.*-->$/,
];

const TYPES_ALLOWED_AS_DEFAULT_CONTEXT = new Set<BootstrapFileType>([
  "AGENTS",
  "SOUL",
  "WORKSPACE",
  "MEMORY",
]);

function normalizeMarkdown(content: string): string {
  return content
    .replace(FRONTMATTER_PATTERN, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function stripMarkdownSyntax(line: string): string {
  return line
    .replace(/^#+\s*/, "")
    .replace(/^[-*]\s*/, "")
    .replace(/[*_`]/g, "")
    .trim();
}

function isTemplateNoiseLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^---+$/.test(trimmed)) return true;
  if (EMPTY_FIELD_PATTERN.test(trimmed)) return true;

  const plain = stripMarkdownSyntax(trimmed);
  if (!plain) return true;
  return TEMPLATE_NOISE_PATTERNS.some((pattern) => pattern.test(plain));
}

function meaningfulLines(content: string): string[] {
  return normalizeMarkdown(content)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !isTemplateNoiseLine(line));
}

export function isWorkspaceDocEffectivelyEmpty(
  fileType: BootstrapFileType,
  content: string
): boolean {
  const normalized = normalizeMarkdown(content);
  if (!normalized) return true;

  // AGENTS / SOUL / WORKSPACE / MEMORY are allowed to carry useful default guidance.
  // USER / IDENTITY / TOOLS should only enter the prompt after the user has filled in
  // real, workspace-specific details; otherwise they add noisy blank templates.
  if (TYPES_ALLOWED_AS_DEFAULT_CONTEXT.has(fileType)) {
    return false;
  }

  const lines = meaningfulLines(normalized);
  const meaningfulText = lines.join("\n").trim();
  return meaningfulText.length < 32;
}

export function sanitizeWorkspacePromptComponent(
  fileType: BootstrapFileType,
  content: string
): string {
  if (isWorkspaceDocEffectivelyEmpty(fileType, content)) {
    return "";
  }
  return normalizeMarkdown(content);
}
