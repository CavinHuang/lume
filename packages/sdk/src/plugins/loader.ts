import { access, readFile } from 'fs/promises'
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
          tools: manifest.tools,
          agents: manifest.agents,
          hooks: manifest.hooks,
          mcpServers: manifest.mcpServers,
          skills: manifest.skills,
          commands: manifest.commands,
          config: spec.config,
        }
        if (manifest.entry) {
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
        // Fall through to module loading.
      }
    }

    if (!plugin) {
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
