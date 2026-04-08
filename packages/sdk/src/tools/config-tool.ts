/**
 * ConfigTool - Dynamic configuration management
 *
 * Closer to the Claude-style tool contract:
 * - `setting` identifies the config key
 * - omit `value` to read
 * - provide `value` to set
 *
 * The implementation keeps session-scoped settings in-memory while
 * preserving the older `{ action, key, value }` shape for compatibility.
 */

import type { ToolDefinition, ToolResult } from '../types.js'

const configStore = new Map<string, unknown>()

const SUPPORTED_SETTINGS = new Set([
  'theme',
  'editorMode',
  'verbose',
  'preferredNotifChannel',
  'autoCompactEnabled',
  'autoMemoryEnabled',
  'autoDreamEnabled',
  'fileCheckpointingEnabled',
  'showTurnDuration',
  'terminalProgressBarEnabled',
  'todoFeatureEnabled',
  'model',
  'permissionMode',
  'permissions.defaultMode',
  'alwaysThinkingEnabled',
  'language',
  'teammateMode',
  'classifierPermissionsEnabled',
  'voiceEnabled',
  'remoteControlAtStartup',
  'taskCompleteNotifEnabled',
  'inputNeededNotifEnabled',
  'agentPushNotifEnabled',
  'promptSuggestions',
  'enableFileCheckpointing',
  'thinking.budgetTokens',
  'thinking.type',
  'sandbox.enabled',
  'sandbox.network.allowedDomains',
  'additionalDirectories',
  'maxTurns',
  'outputFormat.type',
])

function getNestedValue(path: string): unknown {
  return configStore.get(path)
}

function setNestedValue(path: string, value: unknown): void {
  configStore.set(path, value)
}

export function getConfig(key: string): unknown {
  return configStore.get(key)
}

export function setConfig(key: string, value: unknown): void {
  configStore.set(key, value)
}

export function clearConfig(): void {
  configStore.clear()
}

function normalizeInput(input: any): {
  setting?: string
  value?: unknown
  list?: boolean
} {
  if (input?.setting || input?.value !== undefined) {
    return {
      setting: input.setting,
      value: input.value,
      list: false,
    }
  }

  if (input?.action === 'list') {
    return { list: true }
  }

  if (input?.action === 'get' || input?.action === 'set') {
    return {
      setting: input.key,
      value: input.action === 'set' ? input.value : undefined,
      list: false,
    }
  }

  return {
    setting: input?.key,
    value: input?.value,
    list: false,
  }
}

function describeValue(value: unknown): string {
  return JSON.stringify(value)
}

export const ConfigTool: ToolDefinition = {
  name: 'Config',
  description:
    'Get or set session-scoped configuration values such as model, permissions, or prompt suggestion settings.',
  inputSchema: {
    type: 'object',
    properties: {
      setting: {
        type: 'string',
        description:
          'Setting key to read or update, e.g. "model", "permissionMode", "thinking.budgetTokens".',
      },
      value: {
        description: 'Value to write. Omit to read the current value.',
      },

      // Backward-compatible legacy shape
      action: {
        type: 'string',
        enum: ['get', 'set', 'list'],
        description: 'Deprecated legacy operation',
      },
      key: { type: 'string', description: 'Deprecated legacy setting key' },
    },
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() {
    return 'Get or set session-scoped configuration values.'
  },
  async call(input: any, context): Promise<ToolResult> {
    const normalized = normalizeInput(input)

    if (normalized.list) {
      const entries = Array.from(configStore.entries())
      return {
        type: 'tool_result',
        tool_use_id: '',
        content:
          entries.length > 0
            ? entries.map(([key, value]) => `${key} = ${describeValue(value)}`).join('\n')
            : 'No config values set.',
      }
    }

    const setting = normalized.setting?.trim()
    if (!setting) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: 'Error: setting is required',
        is_error: true,
      }
    }

    if (!SUPPORTED_SETTINGS.has(setting) && !setting.startsWith('custom.')) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Error: Unknown setting "${setting}"`,
        is_error: true,
      }
    }

    if (normalized.value === undefined && input?.action !== 'set') {
      const derived = setting === 'permissionMode'
        ? context.permissionMode
        : undefined
      const current = getNestedValue(setting) ?? derived
      return {
        type: 'tool_result',
        tool_use_id: '',
        content:
          current !== undefined
            ? `${setting} = ${describeValue(current)}`
            : `Setting "${setting}" is not set`,
      }
    }

    const previousValue = getNestedValue(setting)
    setNestedValue(setting, normalized.value)
    context.emitEvent?.({
      type: 'system',
      subtype: 'status',
      message: `Config updated: ${setting}`,
      session_id: context.sessionId || '',
      permissionMode: context.permissionMode,
    })

    return {
      type: 'tool_result',
      tool_use_id: '',
      content:
        previousValue === undefined
          ? `Set ${setting} to ${describeValue(normalized.value)}`
          : `Set ${setting} from ${describeValue(previousValue)} to ${describeValue(normalized.value)}`,
    }
  },
}
