import type { ToolResult } from './types.js'

/**
 * Stable per-call state a tool may expose so the engine's repeat guard can
 * recognize equivalent results even when the public content carries volatile
 * fields (operation ids, session ids, timestamps).
 *
 * Without this state the guard falls back to comparing the full serialized
 * result content, which makes the guard ineffective for tools whose output
 * embeds per-call identifiers — typically the tools most prone to stall loops.
 */
export interface RepeatGuardMeta {
  /** Stable snapshot of the outcome used for equivalence comparison. */
  state: unknown
}

/**
 * Attach repeat-guard stable state to a tool result. Preserves any existing
 * `_meta` entries. Tools should expose only fields that genuinely describe
 * the resulting state (url, tree, ok flag), never per-call identifiers.
 */
export function withRepeatGuardState<T extends ToolResult>(result: T, state: unknown): T {
  return {
    ...result,
    _meta: {
      ...result._meta,
      repeatGuard: { state } satisfies RepeatGuardMeta,
    },
  }
}

/** Read the repeat-guard stable state previously attached via {@link withRepeatGuardState}. */
export function readRepeatGuardState(result: Pick<ToolResult, '_meta'>): unknown {
  const meta = result._meta?.repeatGuard
  return meta && typeof meta === 'object' && 'state' in meta
    ? (meta as RepeatGuardMeta).state
    : undefined
}
