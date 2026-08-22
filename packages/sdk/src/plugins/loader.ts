import { access, readFile } from 'fs/promises'
import { execFile } from 'child_process'
import type { ExecFileOptionsWithStringEncoding } from 'child_process'
import { isAbsolute, join, relative, resolve } from 'path'
import { pathToFileURL } from 'url'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import type {
  AgentDefinition,
  AgentOptions,
  McpServerConfig,
  ToolDefinition,
  ToolResult,
} from '../types.js'
import type { HookConfig, HookDefinition } from '../hooks.js'
import type { SkillDefinition } from '../skills/types.js'
import type { CommandDefinition } from '../commands/types.js'
import type { CommandToolContribution } from './normalized.js'
import { spawnWithProcessSandbox } from '../utils/process-sandbox.js'

/**
 * True when `candidate` resolves inside `root` (case-insensitive on Windows).
 * Shared boundary check for plugin-declared paths (#302).
 */
function isInsidePath(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  const normalized = process.platform === 'win32' ? rel.toLowerCase() : rel
  return normalized !== '' ? !normalized.startsWith('..') && !isAbsolute(normalized) : true
}

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
  lume?: { hooksOnly?: boolean }
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

/**
 * cmd.exe re-parses the whole tail after /c with its own grammar; MSVCRT-style
 * argument quoting does not protect against %VAR% expansion or the & | < > ^
 * operators. Node's .bat/.cmd EINVAL hardening exists for exactly this reason,
 * so the model-controlled JSON payload is refused outright when it carries cmd
 * metacharacters and would run through cmd.exe (fail-closed, #317).
 * Manifest-declared command/args are reviewed content (hashed into the
 * permissions hash), so they are not audited here. Exported for tests.
 */
export function findUnsafeCmdArgument(args: string[]): string | undefined {
  return args.find((arg) => /%[^%]*%|[&|<>^\r\n]/.test(arg))
}

/** Returns the offending payload fragment when a command tool call must be blocked (#317). */
function unsafeCmdPayload(command: string, payload: string): string | undefined {
  if (process.platform !== 'win32' || /\.(exe|com)$/i.test(command)) return undefined
  return findUnsafeCmdArgument([payload])
}

function blockedCmdPayloadResult(command: string, unsafe: string, toolUseId: string | undefined): ToolResult {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId ?? '',
    content: `Plugin command "${command}" was blocked: it runs via cmd.exe on Windows and the payload ${JSON.stringify(unsafe)} contains cmd metacharacters (%VAR%, &, |, <, >, ^, newline). Use a .exe/.com executable or enable process isolation.`,
    is_error: true,
  }
}

/**
 * Windows can't execFile() npm's .cmd/.bat shims (EINVAL since Node hardened
 * CVE-2024-27980), and extensionless commands resolve to those shims on PATH.
 * Route everything but .exe/.com through cmd.exe while keeping execFile's
 * timeout/maxBuffer handling (#227).
 */
function execCommandTool(
  command: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) {
  if (process.platform === 'win32' && !/\.(exe|com)$/i.test(command)) {
    return execFile('cmd.exe', ['/d', '/s', '/c', command, ...args], options, callback)
  }
  return execFile(command, args, options, callback)
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

/**
 * Build a ToolDefinition for a plugin command tool (spec §6.3/§16.3).
 *
 * Extracted from the private commandToolFromManifest so the sidecar
 * PluginRuntimeBridge can build command-tool definitions from normalized
 * CommandToolContribution values without going through SDK loadPlugins.
 * `pluginRoot` MUST be absolute (the resolver/normalizer resolve relative
 * paths against the plugin root).
 */
export function buildCommandToolDefinition(
  contribution: CommandToolContribution,
  pluginRoot: string,
): ToolDefinition {
  return {
    name: contribution.name,
    description: contribution.description || contribution.name,
    inputSchema: (contribution.inputSchema as unknown as ToolDefinition['inputSchema']) || { type: 'object', properties: {} },
    isReadOnly: () => contribution.metadata?.isReadOnly === true,
    isConcurrencySafe: () => contribution.metadata?.isConcurrencySafe === true,
    async call(input, context) {
      const payload = JSON.stringify(input ?? {})
      const timeout = Math.max(1, contribution.timeoutMs ?? 30_000)
      const cwd = contribution.cwd ? resolve(pluginRoot, contribution.cwd) : pluginRoot
      const args = [...(contribution.args ?? []), payload]
      const unsafePayload = unsafeCmdPayload(contribution.command, payload)
      if (unsafePayload !== undefined) {
        return blockedCmdPayloadResult(contribution.command, unsafePayload, context.toolUseId)
      }
      if (context.sandbox?.processIsolation?.enabled) {
        return executeSandboxedCommandTool({
          command: contribution.command,
          args,
          cwd,
          timeout,
          payload,
          env: contribution.env,
          context,
        })
      }
      return await new Promise((resolveResult) => {
        const child = execCommandTool(contribution.command, args, {
          cwd,
          timeout,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
          env: {
            ...getDefaultEnvironment(),
            PLUGIN_INPUT: payload,
            ...(contribution.env ?? {}),
            ...(context.toolConfig?.env && typeof context.toolConfig.env === 'object'
              ? (context.toolConfig.env as Record<string, string>)
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
      ...(contribution.metadata ?? {}),
      source: 'plugin',
    },
  }
}

async function executeSandboxedCommandTool(input: {
  command: string
  args: string[]
  cwd: string
  timeout: number
  payload: string
  env?: Record<string, string>
  context: Parameters<NonNullable<ToolDefinition['call']>>[1]
}): Promise<ToolResult> {
  return await new Promise<ToolResult>((resolveResult) => {
    let child: ReturnType<typeof spawnWithProcessSandbox>
    try {
      child = spawnWithProcessSandbox(input.command, input.args, {
        cwd: input.cwd,
        cwdAccess: 'readonly',
        timeoutMs: input.timeout,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...getDefaultEnvironment(),
          PLUGIN_INPUT: input.payload,
          ...(input.env ?? {}),
          ...(input.context.toolConfig?.env && typeof input.context.toolConfig.env === 'object'
            ? input.context.toolConfig.env as Record<string, string>
            : {}),
        },
      }, input.context.sandbox)
    } catch (error) {
      resolveResult({
        type: 'tool_result',
        tool_use_id: input.context.toolUseId ?? '',
        content: error instanceof Error ? error.message : String(error),
        is_error: true,
      })
      return
    }
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let size = 0
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      size += chunk.byteLength
      if (size <= 1024 * 1024) target.push(chunk)
      else child.kill()
    }
    child.stdout?.on('data', collect(stdout))
    child.stderr?.on('data', collect(stderr))
    child.once('error', (error) => resolveResult({
      type: 'tool_result',
      tool_use_id: input.context.toolUseId ?? '',
      content: error.message,
      is_error: true,
    }))
    child.once('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8')
      const err = Buffer.concat(stderr).toString('utf8')
      const failed = code !== 0 || size > 1024 * 1024
      resolveResult({
        type: 'tool_result',
        tool_use_id: input.context.toolUseId ?? '',
        content: size > 1024 * 1024
          ? 'Plugin command output exceeded 1 MiB'
          : [out, err].filter(Boolean).join('\n') || '(no output)',
        ...(failed ? { is_error: true } : {}),
      })
    })
    input.context.abortSignal?.addEventListener('abort', () => child.kill(), { once: true })
  })
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
      const unsafePayload = unsafeCmdPayload(manifest.command, payload)
      if (unsafePayload !== undefined) {
        return blockedCmdPayloadResult(manifest.command, unsafePayload, context.toolUseId)
      }
      return await new Promise((resolveResult) => {
        const child = execCommandTool(manifest.command, args, {
          cwd,
          timeout,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
          env: {
            ...getDefaultEnvironment(),
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

async function resolveHooksConfig(
  hooksField: unknown,
  pluginPath: string,
): Promise<HookConfig | undefined> {
  if (!hooksField) return undefined
  if (typeof hooksField === 'object') {
    console.debug(`[plugin:loader] hooks already an object for ${pluginPath}`);
    return hooksField as HookConfig
  }

  // String path — read and parse the hooks file. Same containment rule as
  // manifest.entry: the value comes from the plugin's own plugin.json (#302).
  const hooksPath = resolve(pluginPath, hooksField as string)
  if (!isInsidePath(pluginPath, hooksPath)) {
    console.warn(`[plugin:loader] hooks path for ${pluginPath} points outside the plugin directory; ignoring`)
    return undefined
  }
  try {
    const raw = JSON.parse(await readFile(hooksPath, 'utf-8')) as Record<string, unknown>
    // Codex format: { "hooks": { "EventName": [...] } }
    const config = raw.hooks && typeof raw.hooks === 'object' ? raw.hooks as HookConfig : raw as HookConfig
    // Strip Codex-specific "type" field from each hook definition
    const cleaned: HookConfig = {}
    for (const [event, definitions] of Object.entries(config)) {
      if (!Array.isArray(definitions)) continue
      cleaned[event] = definitions.map((def) => {
        if (!def || typeof def !== 'object') return def
        const { type: _type, ...rest } = def as Record<string, unknown>
        return rest as HookDefinition
      })
    }
    console.debug(`[plugin:loader] resolved hooks from ${hooksPath}`, {
      pluginPath,
      events: Object.keys(cleaned),
      totalHooks: Object.values(cleaned).reduce((sum, defs) => sum + defs.length, 0),
    });
    return cleaned
  } catch (error) {
    console.warn(`[plugin:loader] failed to resolve hooks for ${pluginPath}`, {
      hooksPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined
  }
}

export async function loadPlugins(
  cwd: string,
  pluginSpecs: AgentOptions['plugins'] = [],
  pluginRoots: string[] = [],
): Promise<LoadedPlugin[]> {
  const loaded: LoadedPlugin[] = []
  const allowedRoots = [resolve(cwd), ...pluginRoots.map((root) => resolve(root))]

  for (const spec of pluginSpecs || []) {
    const pluginPath = (spec as { path?: string }).path
      ? resolve(cwd, (spec as { path?: string }).path as string)
      : resolve(cwd, spec.name)
    // Plugin specs can come from project settings.json; without a boundary a
    // poisoned repo would make the SDK import() arbitrary code (#202).
    const insideAllowedRoot = allowedRoots.some((root) => isInsidePath(root, pluginPath))
    if (!insideAllowedRoot) {
      console.warn(
        `[plugin:loader] skipping plugin "${spec.name}" at ${pluginPath}: outside cwd and pluginRoots`,
      )
      continue
    }
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
          hooks: await resolveHooksConfig(manifest.hooks, pluginPath),
          mcpServers: manifest.mcpServers,
          skills: manifest.skills,
          commands: manifest.commands,
          config: spec.config,
          lume: manifest.lume,
        }
        if (!commandOnly && manifest.entry) {
          // manifest.entry comes from the plugin's own plugin.json; without a
          // containment check "../../x.mjs" would import() code outside the
          // plugin directory (#302).
          const entryPath = resolve(pluginPath, manifest.entry)
          if (!isInsidePath(pluginPath, entryPath)) {
            console.warn(`[plugin:loader] skipping entry for "${spec.name}": outside plugin directory`)
          } else {
            const modulePlugin = await loadPluginModule(entryPath)
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
        }
      } catch (error) {
        if (commandOnly) {
          console.warn(`[plugin:loader] failed to load command plugin "${spec.name}" from ${pluginPath}:`, error)
          continue
        }
        console.warn(`[plugin:loader] manifest/entry failed for "${spec.name}" at ${pluginPath}:`, error)
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

    if (plugin && typeof plugin.hooks === 'string') {
      plugin.hooks = await resolveHooksConfig(plugin.hooks, plugin.path)
    }

    if (plugin) {
      console.debug(`[plugin:loader] plugin loaded`, {
        name: plugin.name,
        path: plugin.path,
        hasHooks: !!plugin.hooks,
        hooksEvents: plugin.hooks ? Object.keys(plugin.hooks) : [],
        hooksCount: plugin.hooks ? Object.values(plugin.hooks).reduce((sum, defs) => sum + defs.length, 0) : 0,
        hasMcpServers: !!plugin.mcpServers,
        hasSkills: !!(plugin.skills?.length),
        hasTools: !!(plugin.tools?.length),
        hasCommands: !!(plugin.commands?.length),
        hooksOnly: plugin.lume?.hooksOnly ?? false,
      });
      loaded.push(plugin)
    } else if (!commandOnly) {
      // A plugin spec that resolves to nothing used to disappear silently (#227).
      console.warn(`[plugin:loader] plugin "${spec.name}" at ${pluginPath} has no loadable manifest or entry module`)
    }
  }

  console.debug(`[plugin:loader] loadPlugins complete`, {
    totalLoaded: loaded.length,
    names: loaded.map((p) => p.name),
    hooksOnlyCount: loaded.filter((p) => p.lume?.hooksOnly).length,
  });
  return loaded
}
