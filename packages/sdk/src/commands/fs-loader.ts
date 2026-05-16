import type { CommandDefinition } from './types.js'

export async function loadCommandDefinitions(
  _cwd: string,
): Promise<CommandDefinition[]> {
  return []
}

export function commandDefinitionsToSlashCommands(
  commands: CommandDefinition[],
) {
  return commands.map((command) => ({
    name: `/${command.name}`,
    description: command.description,
    argumentHint: command.argumentHint,
  }))
}
