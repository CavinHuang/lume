/**
 * Hook System
 *
 * Lifecycle hooks for intercepting agent behavior.
 * Supports pre/post tool use, session lifecycle, and custom events.
 *
 * Hook events:
 * - PreToolUse: before tool execution
 * - PostToolUse: after tool execution
 * - PostToolUseFailure: after tool failure
 * - SessionStart: session initialization
 * - SessionEnd: session cleanup
 * - Stop: when turn completes
 * - SubagentStart: subagent spawned
 * - SubagentStop: subagent completed
 * - UserPromptSubmit: user sends message
 * - PermissionRequest: permission check triggered
 * - TaskCreated: task created
 * - TaskCompleted: task finished
 * - ConfigChange: settings changed
 */

import type {
  SDKHookProgressMessage,
  SDKHookResponseMessage,
  SDKHookStartedMessage,
} from './types.js'

/**
 * All supported hook events.
 */
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Setup',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'UserPromptSubmit',
  'PermissionRequest',
  'PermissionDenied',
  'TaskCreated',
  'TaskCompleted',
  'ConfigChange',
  'PreCompact',
  'PostCompact',
] as const

export type HookEvent = typeof HOOK_EVENTS[number]

/**
 * Hook definition.
 */
export interface HookDefinition {
  /** Shell command or function to execute */
  command?: string
  /** Function handler */
  handler?: (input: HookInput) => Promise<HookOutput | void>
  /** Tool name matcher (regex pattern) */
  matcher?: string
  /** Timeout in milliseconds */
  timeout?: number
}

/**
 * Hook input passed to handlers.
 */
export interface HookInput {
  event: HookEvent
  toolName?: string
  toolInput?: unknown
  toolOutput?: unknown
  toolUseId?: string
  sessionId?: string
  cwd?: string
  error?: string
  [key: string]: unknown
}

/**
 * Hook output returned by handlers.
 */
export interface HookOutput {
  /** Message to append to conversation */
  message?: string
  /** Permission update */
  permissionUpdate?: {
    tool: string
    behavior: 'allow' | 'deny'
  }
  /** Whether to block the action */
  block?: boolean
  /** Notification */
  notification?: {
    title: string
    body: string
    level?: 'info' | 'warning' | 'error'
  }
}

/**
 * Hook configuration (from settings).
 */
export type HookConfig = Record<string, HookDefinition[]>

export interface HookExecutionResult {
  outputs: HookOutput[]
  events: Array<
    SDKHookStartedMessage |
    SDKHookProgressMessage |
    SDKHookResponseMessage
  >
}

/**
 * Hook registry for managing and executing hooks.
 */
export class HookRegistry {
  private hooks: Map<HookEvent, HookDefinition[]> = new Map()

  /**
   * Register hooks from configuration.
   */
  registerFromConfig(config: HookConfig): void {
    for (const [event, definitions] of Object.entries(config)) {
      const hookEvent = event as HookEvent
      if (!HOOK_EVENTS.includes(hookEvent)) continue

      const existing = this.hooks.get(hookEvent) || []
      this.hooks.set(hookEvent, [...existing, ...definitions])
    }
  }

  /**
   * Register a single hook.
   */
  register(event: HookEvent, definition: HookDefinition): void {
    const existing = this.hooks.get(event) || []
    existing.push(definition)
    this.hooks.set(event, existing)
  }

  /**
   * Execute hooks for an event.
   */
  async execute(
    event: HookEvent,
    input: HookInput,
  ): Promise<HookOutput[]> {
    const detailed = await this.executeDetailed(event, input)
    return detailed.outputs
  }

  /**
   * Execute hooks and collect SDK hook events.
   */
  async executeDetailed(
    event: HookEvent,
    input: HookInput,
  ): Promise<HookExecutionResult> {
    const definitions = this.hooks.get(event) || []
    const results: HookOutput[] = []
    const events: HookExecutionResult['events'] = []

    for (const def of definitions) {
      const hookId = crypto.randomUUID()
      const hookName = def.command || def.matcher || 'inline-hook'

      // Check matcher for tool-specific hooks
      if (def.matcher && input.toolName) {
        let regex: RegExp
        try {
          regex = new RegExp(def.matcher)
        } catch (err: any) {
          // An invalid matcher must not take down the whole event: report the
          // def as failed and keep executing the remaining hooks.
          const message = `Invalid matcher: ${err?.message || String(err)}`
          console.error(`[Hook] ${event} hook failed: ${message}`)
          events.push({
            type: 'system',
            subtype: 'hook_response',
            hook_id: hookId,
            hook_name: hookName,
            hook_event: event,
            output: '',
            stdout: '',
            stderr: message,
            outcome: 'error',
            session_id: input.sessionId || '',
          })
          continue
        }
        if (!regex.test(input.toolName)) continue
      }

      events.push({
        type: 'system',
        subtype: 'hook_started',
        hook_id: hookId,
        hook_name: hookName,
        hook_event: event,
        session_id: input.sessionId || '',
      })

      try {
        let output: HookOutput | void = undefined

        if (def.handler) {
          // Function handler
          let timeoutTimer: ReturnType<typeof setTimeout> | undefined
          try {
            const handlerPromise = def.handler(input)
            // Defensive: after a timeout, a late rejection of the handler must
            // never surface as an unhandledRejection outside the race below.
            handlerPromise.catch(() => {})
            output = await Promise.race([
              handlerPromise,
              new Promise<void>((_, reject) => {
                timeoutTimer = setTimeout(() => reject(new Error('Hook timeout')), def.timeout || 30000)
              }),
            ])
          } finally {
            clearTimeout(timeoutTimer)
          }
        }

        if (output) {
          results.push(output)
        }
        if (def.handler) {
          const outputMessage =
            output && typeof output === 'object' && 'message' in output
              ? output.message || ''
              : ''
          events.push({
            type: 'system',
            subtype: 'hook_response',
            hook_id: hookId,
            hook_name: hookName,
            hook_event: event,
            output: outputMessage,
            stdout: '',
            stderr: '',
            outcome: 'success',
            session_id: input.sessionId || '',
          })
        }
      } catch (err: any) {
        // Log but don't fail on hook errors
        console.error(`[Hook] ${event} hook failed: ${err.message}`)
        events.push({
          type: 'system',
          subtype: 'hook_response',
          hook_id: hookId,
          hook_name: hookName,
          hook_event: event,
          output: '',
          stdout: '',
          stderr: err.message || 'Hook failed',
          outcome: 'error',
          session_id: input.sessionId || '',
        })
      }
    }

    return { outputs: results, events }
  }

  /**
   * Check if any hooks are registered for an event.
   */
  hasHooks(event: HookEvent): boolean {
    return (this.hooks.get(event)?.length || 0) > 0
  }

  /**
   * Clear all hooks.
   */
  clear(): void {
    this.hooks.clear()
  }
}

/**
 * Create a default hook registry.
 */
export function createHookRegistry(config?: HookConfig): HookRegistry {
  const registry = new HookRegistry()
  if (config) {
    registry.registerFromConfig(config)
  }
  return registry
}
