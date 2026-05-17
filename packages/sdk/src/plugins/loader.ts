import { access, readFile } from 'fs/promises'
import { execFile } from 'child_process'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'
import type {
  AgentDefinition,
  AgentOptions,
  McpServerConfig,
  ToolDefinition,
} from '../types.js'
import type { HookConfig } from '../hooks.js'
import type { SkillDefinition } from '../skills/types.js'
import type { CommandDefinition } from '../commands/types.js'

export interface LoadedPlugin {
  name: string
  path: string
  source?: string
  tools?: ToolDefinition[]
  agents?: Record<string, AgentDefinition>
  hooks?: HookConfig
  mcpServers?: Record<string, McpServerConfig>
  skills?: SkillDefinition[]
  commands?: CommandDefinition[]
  config?: Record<string, unknown>
}

type PluginModule =
  | LoadedPlugin
  | {
      default?: LoadedPlugin
    }

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

interface CommandToolManifest {
  name: string
  description?: string
  command: string
  args?: string[]
  cwd?: string
  timeoutMs?: number
  inputSchema?: ToolDefinition['inputSchema']
  metadata?: Record<string, unknown>
}

function isCommandToolManifest(value: unknown): value is CommandToolManifest {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.name === 'string' && typeof record.command === 'string'
}

function normalizeManifestTools(
  tools: unknown,
  pluginPath: string,
  options: { commandOnly?: boolean } = {},
): ToolDefinition[] | undefined {
  if (!Array.isArray(tools)) return undefined
  const normalized: ToolDefinition[] = []
  for (const tool of tools) {
    if (isCommandToolManifest(tool)) {
      normalized.push(commandToolFromManifest(tool, pluginPath))
      continue
    }
    if (!options.commandOnly) {
      normalized.push(tool as ToolDefinition)
    }
  }
  return normalized
}

function commandToolFromManifest(manifest: CommandToolManifest, pluginPath: string): ToolDefinition {
  return {
    name: manifest.name,
    description: manifest.description || manifest.name,
    inputSchema: manifest.inputSchema || { type: 'object', properties: {} },
    isReadOnly: () => manifest.metadata?.isReadOnly === true,
    isConcurrencySafe: () => manifest.metadata?.isConcurrencySafe === true,
    async call(input, context) {
      const payload = JSON.stringify(input ?? {})
      const timeout = Math.max(1, manifest.timeoutMs ?? 30_000)
      const cwd = manifest.cwd ? resolve(pluginPath, manifest.cwd) : pluginPath
      const args = [...(manifest.args ?? []), payload]
      return await new Promise((resolveResult) => {
        const child = execFile(manifest.command, args, {
          cwd,
          timeout,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            PLUGIN_INPUT: payload,
            ...(context.toolConfig?.env && typeof context.toolConfig.env === 'object'
              ? context.toolConfig.env as Record<string, string>
              : {}),
          },
        }, (error, stdout, stderr) => {
          if (error) {
            const output = [error.message, stderr && `stderr: ${stderr}`, stdout && `stdout: ${stdout}`]
              .filter(Boolean)
              .join('\n')
            resolveResult({
              type: 'tool_result',
              tool_use_id: context.toolUseId ?? '',
              content: output,
              is_error: true,
            })
            return
          }
          resolveResult({
            type: 'tool_result',
            tool_use_id: context.toolUseId ?? '',
            content: stdout || stderr || '(no output)',
          })
        })
        if (context.abortSignal) {
          context.abortSignal.addEventListener('abort', () => child.kill(), { once: true })
        }
      })
    },
    runtimeMetadata: {
      ...(manifest.metadata ?? {}),
      source: 'plugin',
    },
  } as ToolDefinition
}

async function loadPluginModule(path: string): Promise<LoadedPlugin | null> {
  const module = (await import(pathToFileURL(path).href)) as PluginModule
  const plugin = 'default' in module && module.default ? module.default : (module as LoadedPlugin)
  if (!plugin || typeof plugin !== 'object') return null
  return plugin
}

export async function loadPlugins(
  cwd: string,
  pluginSpecs: AgentOptions['plugins'] = [],
): Promise<LoadedPlugin[]> {
  const loaded: LoadedPlugin[] = []

  for (const spec of pluginSpecs || []) {
    const pluginPath = (spec as { path?: string }).path
      ? resolve(cwd, (spec as { path?: string }).path as string)
      : resolve(cwd, spec.name)
    const commandOnly = (spec as { kind?: string }).kind === 'command'

    const manifestPath = join(pluginPath, 'plugin.json')
    const indexCandidates = [
      join(pluginPath, 'index.js'),
      join(pluginPath, 'index.mjs'),
      join(pluginPath, 'dist', 'index.js'),
    ]

    let plugin: LoadedPlugin | null = null

    if (await fileExists(manifestPath)) {
      try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as LoadedPlugin & {
          entry?: string
        }
        plugin = {
          name: manifest.name || spec.name,
          path: pluginPath,
          source: manifest.source,
          tools: normalizeManifestTools(manifest.tools, pluginPath, { commandOnly }),
          agents: manifest.agents,
          hooks: manifest.hooks,
          mcpServers: manifest.mcpServers,
          skills: manifest.skills,
          commands: manifest.commands,
          config: spec.config,
        }
        if (!commandOnly && manifest.entry) {
          const modulePlugin = await loadPluginModule(resolve(pluginPath, manifest.entry))
          if (modulePlugin) {
            plugin = {
              ...plugin,
              ...modulePlugin,
              name: modulePlugin.name || plugin.name,
              path: pluginPath,
              config: spec.config,
            }
          }
        }
      } catch {
        if (commandOnly) {
          continue
        }
        // Fall through to module loading.
      }
    }

    if (!plugin && !commandOnly) {
      for (const candidate of indexCandidates) {
        if (!(await fileExists(candidate))) continue
        const modulePlugin = await loadPluginModule(candidate)
        if (modulePlugin) {
          plugin = {
            ...modulePlugin,
            name: modulePlugin.name || spec.name,
            path: pluginPath,
            config: spec.config,
          }
          break
        }
      }
    }

    if (plugin) {
      loaded.push(plugin)
    }
  }

  return loaded
}
