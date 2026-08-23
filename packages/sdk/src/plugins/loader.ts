import { execFile } from 'child_process'
import type { ExecFileOptionsWithStringEncoding } from 'child_process'
import { resolve } from 'path'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import type {
  ToolDefinition,
  ToolResult,
} from '../types.js'
import type { CommandToolContribution } from './normalized.js'
import { spawnWithProcessSandbox } from '../utils/process-sandbox.js'

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

/**
 * Build a ToolDefinition for a plugin command tool (spec §6.3/§16.3).
 *
 * The sidecar PluginRuntimeBridge builds command-tool definitions from
 * normalized CommandToolContribution values.
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
