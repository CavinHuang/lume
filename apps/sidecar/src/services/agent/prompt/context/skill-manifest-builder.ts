export interface SkillManifestItem {
  slug: string;
  name?: string;
  description?: string;
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
    return "需求不清时的模糊产品/设计探索";
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
  // Skill 匹配时机由静态 prompt「## 执行模式」段单点声明，此处只保留调用语法
  const lines = [
    "已加载 Skill：",
    `- Skill 调用前缀: ${pluginPrefix}:`,
    "- 以 <前缀><skill-slug> 调用；下表仅列 slug 以节省 prompt token"
  ];

  for (const skill of modelInvocableSkills) {
    const compactDescription = compactSkillDescription(skill.slug, skill.description);
    const desc = compactDescription ? `: ${compactDescription}` : "";
    const args = compactText(skill.argumentHint, 72);
    lines.push(`- ${formatSkillManifestName(skill)}${desc}${args ? ` Args: ${args}` : ""}`);
  }

  return lines;
}
