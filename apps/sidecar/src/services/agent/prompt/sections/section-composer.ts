import type { PromptSection, PromptSectionMode } from "../types";

export function renderPromptSection(section: PromptSection): string {
  if (section.title) {
    return `## ${section.title}\n\n${section.content.trim()}`;
  }
  return section.content.trim();
}

export function composePromptSections(
  sections: Array<PromptSection | null | undefined>,
  mode: PromptSectionMode
): string {
  return sections
    .filter((section): section is PromptSection => Boolean(section?.content.trim()))
    .filter((section) => section.mode.includes(mode))
    .sort((a, b) => a.priority - b.priority)
    .map(renderPromptSection)
    .join("\n\n");
}
