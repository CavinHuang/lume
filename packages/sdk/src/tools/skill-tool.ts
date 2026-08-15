/**
 * Skill Tool
 *
 * Allows the model to invoke registered skills by name.
 * Skills are prompt templates that provide specialized capabilities.
 */

import { dirname } from 'path'
import type { ToolDefinition, ToolResult, ToolContext } from '../types.js'
import type { SkillDefinition } from '../skills/types.js'
import { recordSkillUsage } from '../skills/evolution.js'
import {
  SkillRegistry,
  getModelInvocableSkills,
  getSkill,
  getUserInvocableSkills,
} from '../skills/registry.js'

function formatSkillPromptName(skill: SkillDefinition): string {
  const displayName = skill.aliases
    ?.map((alias) => alias.trim())
    .find((alias) => alias && alias !== skill.name)
  return displayName ? `${skill.name} (${displayName})` : skill.name
}

interface SkillLookup {
  get(name: string): SkillDefinition | undefined
  getUserInvocable(): SkillDefinition[]
  getModelInvocable(): SkillDefinition[]
}

const globalSkillLookup: SkillLookup = {
  get: getSkill,
  getUserInvocable: getUserInvocableSkills,
  getModelInvocable: getModelInvocableSkills,
}

export function createSkillTool(registry: SkillRegistry | SkillLookup = globalSkillLookup): ToolDefinition {
  return {
  name: 'Skill',
  description:
    'Execute a skill within the current conversation. ' +
    'Skills provide specialized capabilities and domain knowledge. ' +
    'Use this tool with the skill name and optional arguments. ' +
    'Available skills are listed in an <available_skills> runtime context block.',
  inputSchema: {
    type: 'object',
    properties: {
      skill: {
        type: 'string',
        description: 'The skill name to execute (e.g., "commit", "review", "simplify")',
      },
      args: {
        type: 'string',
        description: 'Optional arguments for the skill',
      },
    },
    required: ['skill'],
  },

  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => registry.getUserInvocable().length > 0,

  async prompt(): Promise<string> {
    const skills = registry.getModelInvocable()
    if (skills.length === 0) return ''

    const lines = skills.map((s) => {
      const desc =
        s.description.length > 200
          ? s.description.slice(0, 200) + '...'
          : s.description
      const args = s.argumentHint ? ` Args: ${s.argumentHint}` : ''
      return `- ${formatSkillPromptName(s)}: ${desc}${args}`
    })

    return (
      'Execute a skill within the main conversation.\n\n' +
      'Available skills:\n' +
      lines.join('\n') +
      '\n\nWhen a skill matches the user\'s request, invoke it using the Skill tool.'
    )
  },

  async call(input: any, context: ToolContext): Promise<ToolResult> {
    const skillName: string = input.skill
    const args: string = typeof input.args === 'string' ? input.args.trim() : ''

    if (!skillName) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: 'Error: skill name is required',
        is_error: true,
      }
    }

    const skill = registry.get(skillName)
    if (!skill) {
      const available = registry.getUserInvocable()
        .map((s) => s.name)
        .join(', ')
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Error: Unknown skill "${skillName}". Available skills: ${available || 'none'}`,
        is_error: true,
      }
    }

    // Check if skill is enabled
    if (skill.isEnabled && !skill.isEnabled()) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Error: Skill "${skillName}" is currently disabled`,
        is_error: true,
      }
    }

    if (!args && skill.argumentHint) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Skill "${skill.name}" requires arguments. Ask the user: ${skill.argumentHint}`,
        is_error: true,
      }
    }

    try {
      // Get skill prompt
      const contentBlocks = await skill.getPrompt(args, context)

      // Convert content blocks to text
      const promptText = contentBlocks
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n\n')

      const skillDir = skill.sourcePath ? dirname(skill.sourcePath) : undefined
      const finalPrompt = skillDir
        ? `${promptText}\n\nReferences and relative paths in this skill resolve against: ${skillDir}`
        : promptText

      // Build result with metadata
      const result: Record<string, unknown> = {
        success: true,
        commandName: skill.name,
        status: skill.context === 'fork' ? 'forked' : 'inline',
        prompt: finalPrompt,
        ...(skillDir ? { skillDir } : {}),
      }

      if (skill.allowedTools) {
        result.allowedTools = skill.allowedTools
      }
      if (skill.activatedTools) {
        result.activatedTools = skill.activatedTools
      }

      if (skill.model) {
        result.model = skill.model
      }

      await recordSkillUsage({
        skillName: skill.name,
        skillPath: skill.sourcePath,
        sessionId: context.sessionId,
      }).catch(() => undefined)

      return {
        type: 'tool_result',
        tool_use_id: '',
        content: JSON.stringify(result),
      }
    } catch (err: any) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Error executing skill "${skillName}": ${err.message}`,
        is_error: true,
      }
    }
  },
  }
}

export const SkillTool: ToolDefinition = createSkillTool()
