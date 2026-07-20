import type { SkillMeta } from "@lume/shared";
import YAML from "yaml";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function pickBoolean(record: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
    if (typeof value !== "string") continue;
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return undefined;
}

function pickStringList(record: Record<string, unknown>, ...keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
    }
    if (typeof value !== "string") continue;
    const items = value
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    if (items.length > 0) return items;
  }
  return undefined;
}

export function parseSkillFrontmatter(content: string, slug: string): SkillMeta {
  const meta: SkillMeta = { slug, name: slug };
  const frontmatterMatch = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatterMatch) return meta;

  let parsed: unknown;
  try {
    parsed = YAML.parse(frontmatterMatch[1] ?? "");
  } catch {
    return meta;
  }
  if (!isRecord(parsed)) return meta;

  const metadata = isRecord(parsed.metadata) ? parsed.metadata : {};

  const name = pickString(parsed, "name");
  const description = pickString(parsed, "description");
  const whenToUse = pickString(parsed, "when_to_use", "whenToUse", "when-to-use")
    ?? pickString(metadata, "when_to_use", "whenToUse", "when-to-use");
  const allowedTools = pickStringList(parsed, "allowed_tools", "allowedTools", "allowed-tools");
  const argumentHint = pickString(parsed, "argument_hint", "argumentHint", "argument-hint");
  const disableModelInvocation = pickBoolean(parsed, "disable_model_invocation", "disableModelInvocation");
  const icon = pickString(parsed, "icon");
  const version = pickString(parsed, "version") ?? pickString(metadata, "version");

  return {
    ...meta,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(whenToUse ? { whenToUse } : {}),
    ...(allowedTools && allowedTools.length > 0 ? { allowedTools } : {}),
    ...(argumentHint ? { argumentHint } : {}),
    ...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}),
    ...(icon ? { icon } : {}),
    ...(version ? { version } : {})
  };
}
