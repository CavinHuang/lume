export interface SkillManifestItem {
  slug: string;
  description?: string;
}

export function compactSkillDescription(slug: string, description?: string): string {
  if (slug === "brainstorming") {
    return "ambiguous product/design exploration when requirements are unclear";
  }
  const normalized = (description ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const sentence = normalized.split(/(?<=[.!?。！？])\s+/)[0]?.trim() ?? normalized;
  return sentence.length > 96 ? `${sentence.slice(0, 93).trim()}...` : sentence;
}

export function renderSkillManifestLines(ctx: {
  workspaceSlug: string;
  skills: SkillManifestItem[];
}): string[] {
  if (ctx.skills.length === 0) return [];

  const pluginPrefix = `lume-workspace-${ctx.workspaceSlug}`;
  const lines = [
    "Loaded Skills:",
    `- Skill call prefix: ${pluginPrefix}:`,
    "- Call skills as <prefix><skill-slug>; list below shows slugs only to save prompt tokens",
    "- Use a loaded Skill only when it clearly matches the user's request",
    "- Only fall back to raw tool composition when no suitable Skill fits"
  ];

  for (const skill of ctx.skills) {
    const compactDescription = compactSkillDescription(skill.slug, skill.description);
    const desc = compactDescription ? `: ${compactDescription}` : "";
    lines.push(`- ${skill.slug}${desc}`);
  }

  return lines;
}
