export interface SkillManifestItem {
  slug: string;
  name?: string;
  description?: string;
  whenToUse?: string;
  argumentHint?: string;
  disableModelInvocation?: boolean;
}

function compactText(text?: string, maxLength = 96): string {
  const normalized = (text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const sentence = normalized.split(/(?<=[.!?。！？])\s+/)[0]?.trim() ?? normalized;
  return sentence.length > maxLength ? `${sentence.slice(0, maxLength - 3).trim()}...` : sentence;
}

export function compactSkillDescription(slug: string, description?: string): string {
  if (slug === "brainstorming") {
    return "ambiguous product/design exploration when requirements are unclear";
  }
  return compactText(description);
}

function formatSkillManifestName(skill: Pick<SkillManifestItem, "slug" | "name">): string {
  const displayName = skill.name?.trim();
  return displayName && displayName !== skill.slug
    ? `${skill.slug} (${displayName})`
    : skill.slug;
}

export function renderSkillManifestLines(ctx: {
  workspaceSlug: string;
  skills: SkillManifestItem[];
}): string[] {
  const modelInvocableSkills = ctx.skills.filter((skill) => skill.disableModelInvocation !== true);
  if (modelInvocableSkills.length === 0) return [];

  const pluginPrefix = `lume-workspace-${ctx.workspaceSlug}`;
  const lines = [
    "Loaded Skills:",
    `- Skill call prefix: ${pluginPrefix}:`,
    "- Call skills as <prefix><skill-slug>; list below shows slugs only to save prompt tokens",
    "- Use a loaded Skill only when it clearly matches the user's request",
    "- Only fall back to raw tool composition when no suitable Skill fits"
  ];

  for (const skill of modelInvocableSkills) {
    const compactDescription = compactSkillDescription(skill.slug, skill.description);
    const desc = compactDescription ? `: ${compactDescription}` : "";
    const args = compactText(skill.argumentHint, 72);
    lines.push(`- ${formatSkillManifestName(skill)}${desc}${args ? ` Args: ${args}` : ""}`);
  }

  return lines;
}
