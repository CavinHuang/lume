import type { LumeWorkflowHookHandlerRegistry } from "./hook-events";
import { readPluginSkillContent, listPluginSkillDirs } from "../skills/workspace-skill-editor-service";

// Matches $plugin:skill syntax
const PLUGIN_SKILL_PATTERN = /\$([\w-]+):(\w+)/g;
// Matches bare $plugin syntax (not followed by :)
const PLUGIN_ONLY_PATTERN = /\$([\w-]+)(?![:\w])/g;

export function createCorePluginHookHandlers(): LumeWorkflowHookHandlerRegistry {
  return {
    "core.plugin.skill-activation": async (event, _context) => {
      if (event.event !== "context.beforeAssemble") return { effects: [] };
      const userMessage = event.userMessage?.trim();
      if (!userMessage) return { effects: [] };

      const activatedSkills: Array<{ pluginName: string; skillSlug: string; content: string }> = [];
      const activatedPluginNames = new Set<string>();
      let match: RegExpExecArray | null;

      // Pass 1: Match $plugin:skill → load specific skill
      PLUGIN_SKILL_PATTERN.lastIndex = 0;
      while ((match = PLUGIN_SKILL_PATTERN.exec(userMessage)) !== null) {
        const pluginName = match[1]!;
        const skillSlug = match[2]!;
        const content = readPluginSkillContent(pluginName, skillSlug);
        if (content) {
          activatedSkills.push({ pluginName, skillSlug, content });
          activatedPluginNames.add(pluginName);
        }
      }

      // Pass 2: Match bare $plugin → load all skills (skip already-activated plugins)
      PLUGIN_ONLY_PATTERN.lastIndex = 0;
      while ((match = PLUGIN_ONLY_PATTERN.exec(userMessage)) !== null) {
        const pluginName = match[1]!;
        if (activatedPluginNames.has(pluginName)) continue; // already handled by $plugin:skill
        const skillDirs = listPluginSkillDirs(pluginName);
        for (const skillSlug of skillDirs) {
          const content = readPluginSkillContent(pluginName, skillSlug);
          if (content) {
            activatedSkills.push({ pluginName, skillSlug, content });
          }
        }
      }

      if (activatedSkills.length === 0) return { effects: [] };

      // Remove $plugin:skill and $plugin syntax from user message
      const cleanedMessage = userMessage
        .replace(PLUGIN_SKILL_PATTERN, "")
        .replace(PLUGIN_ONLY_PATTERN, "")
        .trim();
      const skillContextBlocks = activatedSkills.map(
        ({ pluginName, skillSlug, content }) =>
          `[Skill: ${pluginName}:${skillSlug}]\n${content}\n[/Skill]`
      ).join("\n\n");

      const userMessageForModel = cleanedMessage.length > 0
        ? `${skillContextBlocks}\n\n用户请求: ${cleanedMessage}`
        : skillContextBlocks;

      return {
        effects: [{
          type: "appendContext",
          source: "hook:plugin-skill-activation",
          content: skillContextBlocks,
          hidden: false,
          usedMemoryItems: [],
          userMessageForModel
        }]
      };
    }
  };
}
