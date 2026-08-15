/** Layered tool registry: global → preset → agent, resolved at assembly time. */

import type { ToolDefinition } from '../types.js'
import { matchesAnyToolPattern } from '../utils/tool-approval.js'
import { filterTools } from './index.js'

export interface ToolMask {
  allow?: string[]
  deny?: string[]
}

export interface RegistryView {
  visible(): ToolDefinition[]
  split(): { core: ToolDefinition[]; deferred: ToolDefinition[] }
}

export interface LayerHandle {
  register(tools: ToolDefinition[]): () => void
  setCore(names: string[]): void
  restrict(mask: ToolMask): () => void
}

export interface ToolRegistry {
  global: LayerHandle
  preset(key: string): LayerHandle
  agent(id: string): LayerHandle & { view(): RegistryView }
}

interface Layer {
  tools: Map<string, ToolDefinition>
  order: string[]
  core: Set<string> | undefined
  masks: ToolMask[]
}

const RESERVED = new Set(['ToolSearch', 'ExecuteTool'])

function newLayer(): Layer {
  return { tools: new Map(), order: [], core: undefined, masks: [] }
}

function handle(layer: Layer): LayerHandle {
  return {
    register(tools) {
      for (const t of tools) {
        if (!layer.tools.has(t.name)) layer.order.push(t.name)
        layer.tools.set(t.name, t)
      }
      return () => {
        for (const t of tools) {
          layer.tools.delete(t.name)
          const index = layer.order.indexOf(t.name)
          if (index >= 0) layer.order.splice(index, 1)
        }
      }
    },
    setCore(names) {
      layer.core = new Set(names)
    },
    restrict(mask) {
      layer.masks.push(mask)
      return () => {
        const index = layer.masks.indexOf(mask)
        if (index >= 0) layer.masks.splice(index, 1)
      }
    },
  }
}

export function createToolRegistry(): ToolRegistry {
  const globalLayer = newLayer()
  const presets = new Map<string, Layer>()
  const agents = new Map<string, Layer>()

  const layerOf = (map: Map<string, Layer>, key: string): Layer => {
    let layer = map.get(key)
    if (!layer) map.set(key, (layer = newLayer()))
    return layer
  }

  // ponytail: only the "default" preset participates in resolution until P2; other preset keys register but do not resolve.
  const chain = (id: string): Layer[] => [globalLayer, layerOf(presets, 'default'), layerOf(agents, id)]

  const merged = (id: string): { byName: Map<string, ToolDefinition>; order: string[] } => {
    const byName = new Map<string, ToolDefinition>()
    const order: string[] = []
    for (const layer of chain(id)) {
      for (const name of layer.order) {
        const t = layer.tools.get(name)
        if (!t) continue
        if (!byName.has(name)) order.push(name)
        byName.set(name, t)
      }
    }
    return { byName, order }
  }

  return {
    global: handle(globalLayer),
    preset: (key) => handle(layerOf(presets, key)),
    agent: (id) => {
      const layer = layerOf(agents, id)
      const view: RegistryView = {
        visible() {
          const { byName, order } = merged(id)
          const masks = chain(id).flatMap((l) => l.masks)
          const allows = masks.map((m) => m.allow).filter((a): a is string[] => !!a && a.length > 0)
          const denies = masks.flatMap((m) => m.deny ?? [])
          return order
            .map((name) => byName.get(name)!)
            .filter((t) => allows.every((a) => matchesAnyToolPattern(t.name, a)))
            .filter((t) => !matchesAnyToolPattern(t.name, denies))
        },
        split() {
          const visible = this.visible().filter((t) => !RESERVED.has(t.name))
          const core = chain(id).reverse().find((l) => l.core !== undefined)?.core ?? new Set<string>()
          return {
            core: visible.filter((t) => core.has(t.name) || t.runtimeMetadata?.requiredDuringSkillScope === true),
            deferred: visible.filter((t) => !core.has(t.name) && t.runtimeMetadata?.requiredDuringSkillScope !== true),
          }
        },
      }
      return { ...handle(layer), view: () => view }
    },
  }
}

/** Query-time tool overrides, structurally compatible with `Partial<AgentOptions>`. */
export interface ToolOverrides {
  disallowedTools?: string[]
  tools?: string[] | ToolDefinition[] | { type: 'preset'; preset: 'default' }
}

/**
 * Evaluate query-time overrides as agent-layer masks; `undo` restores the registry.
 * Tool-definition arrays (including empty ones) bypass the registry and replace
 * the pool outright, matching the legacy override semantics.
 *
 * When `pools` (the caller's live tool/deferred pools) is provided, the deny
 * path pattern-filters those pools so eager/generated tools (ToolSearch,
 * ExecuteTool) survive and deferred tools never leak into the main pool; the
 * mask registration is only a semantic declaration for future registry-native
 * evaluation (P2) — it does not affect this snapshot, and one-shot callers
 * (e.g. getRunTools) undo it right after reading the result.
 */
export function applyOverrides(
  registry: ToolRegistry,
  agentId: string,
  overrides: ToolOverrides | undefined,
  pools?: { tools: ToolDefinition[]; deferredTools: ToolDefinition[] },
): { tools: ToolDefinition[]; deferredTools: ToolDefinition[]; undo: () => void } {
  if (!overrides) {
    if (pools) return { tools: pools.tools, deferredTools: pools.deferredTools, undo: () => {} }
    const view = registry.agent(agentId).view()
    return { tools: view.visible(), deferredTools: view.split().deferred, undo: () => {} }
  }
  if (Array.isArray(overrides.tools) && (overrides.tools.length === 0 || typeof overrides.tools[0] !== 'string')) {
    return { tools: overrides.tools as ToolDefinition[], deferredTools: [], undo: () => {} }
  }
  const layer = registry.agent(agentId)
  const undos: Array<() => void> = []
  const explicitList = Array.isArray(overrides.tools) ? (overrides.tools as string[]) : undefined
  if (overrides.disallowedTools) {
    undos.push(layer.restrict({ deny: overrides.disallowedTools }))
  }
  if (explicitList) {
    // Legacy semantics: an explicit string list intersects with the deny mask
    // (allow ∩ ¬deny) — the old base-pool builder already subtracted
    // disallowedTools before applying the allow list, so both masks register
    // and visible() applies the allow-intersection then the deny-union.
    undos.push(layer.restrict({ allow: explicitList }))
  }
  const undoAll = () => {
    for (const undo of undos) undo()
  }
  const denied = overrides.disallowedTools
  try {
    const view = layer.view()
    if (explicitList) {
      // Declared deviation: pool source is the registry's full global pool
      // (includes MCP and runtime-resolved tools) instead of buildBaseToolPool.
      return { tools: view.visible(), deferredTools: [], undo: undoAll }
    }
    if (pools) {
      return {
        tools: filterTools(pools.tools, undefined, denied),
        deferredTools: overrides.tools ? [] : filterTools(pools.deferredTools, undefined, denied),
        undo: undoAll,
      }
    }
    const split = view.split()
    return {
      tools: split.core,
      deferredTools: overrides.tools ? [] : split.deferred,
      undo: undoAll,
    }
  } catch (error) {
    undoAll()
    throw error
  }
}
