export type SkillSystemToolGroupId =
  | 'shell'
  | 'file-read'
  | 'file-write'
  | 'search'
  | 'code-intelligence'
  | 'web'
  | 'data'
  | 'memory'
  | 'agent'
  | 'task'
  | 'automation'
  | 'user-interaction'
  | 'channel'
  | 'evolution'
  | 'office'
  | 'reading'

export interface SkillToolDefinition {
  value: string
  label: string
  systemGroupId: SkillSystemToolGroupId
  disabled?: boolean
  skillAllowed?: boolean
}

export const SKILL_TOOL_DEFINITIONS: SkillToolDefinition[] = [
  { value: 'bash', label: 'bash', systemGroupId: 'shell' },
  { value: 'read_file', label: 'read_file', systemGroupId: 'file-read' },
  { value: 'write_file', label: 'write_file', systemGroupId: 'file-write' },
  { value: 'edit_file', label: 'edit_file', systemGroupId: 'file-write' },
  { value: 'grep', label: 'grep', systemGroupId: 'search' },
  { value: 'list_dir', label: 'list_dir', systemGroupId: 'search' },
  { value: 'web_search', label: 'web_search', systemGroupId: 'web' },
  { value: 'web_fetch', label: 'web_fetch', systemGroupId: 'web' },
  { value: 'personalize_ui', label: 'personalize_ui', systemGroupId: 'evolution' },
  { value: 'lume_reading_snapshot', label: 'lume_reading_snapshot', systemGroupId: 'reading' },
  { value: 'lume_generate_share_card', label: 'lume_generate_share_card', systemGroupId: 'reading' },
  { value: 'office_validate', label: 'office_validate', systemGroupId: 'office' },
  { value: 'office_unpack', label: 'office_unpack', systemGroupId: 'office' },
  { value: 'office_pack', label: 'office_pack', systemGroupId: 'office' },
  { value: 'agent_spawn', label: 'agent_spawn', systemGroupId: 'agent', disabled: true },
]

export function getSkillAllowedToolOptions(): SkillToolDefinition[] {
  return SKILL_TOOL_DEFINITIONS.filter((definition) => definition.skillAllowed !== false)
}

export function getSystemToolDefinitionValues(groupId: SkillSystemToolGroupId): string[] {
  return SKILL_TOOL_DEFINITIONS
    .filter((definition) => definition.systemGroupId === groupId)
    .map((definition) => definition.value)
}
