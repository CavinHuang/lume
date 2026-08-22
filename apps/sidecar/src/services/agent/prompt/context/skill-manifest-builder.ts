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

// 内置 Office 工具存在时，文档类 skill 的"凡处理文件即调 skill"教学与 Office 工具策略
// 的"优先内置工具"指令直接竞争，从清单中隐藏（Skill 本身仍可被显式调用）
const OFFICE_FILE_SKILL_SLUGS = new Set(["docx", "pdf", "pptx", "xlsx"]);

export function renderSkillManifestLines(ctx: {
  workspaceSlug: string;
  skills: SkillManifestItem[];
  hasOfficeTools?: boolean;
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
    if (ctx.hasOfficeTools && OFFICE_FILE_SKILL_SLUGS.has(skill.slug)) continue;
    const compactDescription = compactSkillDescription(skill.slug, skill.description);
    const desc = compactDescription ? `: ${compactDescription}` : "";
    const args = compactText(skill.argumentHint, 72);
    lines.push(`- ${formatSkillManifestName(skill)}${desc}${args ? ` Args: ${args}` : ""}`);
  }

  return lines;
}
