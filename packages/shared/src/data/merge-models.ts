import type { ModelCapabilities, ModelMeta, ModelPricing } from './model-meta'
import type { ModelOverride } from './model-meta.override'

/** 并集去重 aliases，generated 在前；两者皆空返回 undefined。 */
function unionAliases(generated?: string[], override?: string[]): string[] | undefined {
  if (!generated && !override) return undefined
  const seen = new Set<string>()
  const out: string[] = []
  for (const alias of [...(generated ?? []), ...(override ?? [])]) {
    if (!seen.has(alias)) {
      seen.add(alias)
      out.push(alias)
    }
  }
  return out.length ? out : undefined
}

/** 用 override 深合并一个 generated 条目。 */
function applyOverride(meta: ModelMeta, override: ModelOverride): ModelMeta {
  const merged: ModelMeta = {
    ...meta,
    capabilities: { ...meta.capabilities, ...(override.capabilities ?? {}) },
    aliases: unionAliases(meta.aliases, override.aliases),
  }
  if (override.displayName !== undefined) merged.displayName = override.displayName
  if (override.contextWindow !== undefined) merged.contextWindow = override.contextWindow
  if (override.description !== undefined) merged.description = override.description
  if (override.pricing !== undefined) merged.pricing = override.pricing
  return merged
}

/** 由 override 构造 standalone 条目（generated 中不存在）。未指定的 capability 分量补 false。 */
function overrideToStandalone(id: string, ov: ModelOverride): ModelMeta {
  const meta: ModelMeta = {
    id,
    displayName: ov.displayName ?? id,
    contextWindow: ov.contextWindow ?? 0,
    capabilities: { vision: false, toolUse: false, reasoning: false, ...(ov.capabilities ?? {}) },
  }
  if (ov.description !== undefined) meta.description = ov.description
  if (ov.pricing !== undefined) meta.pricing = ov.pricing
  if (ov.aliases !== undefined && ov.aliases.length) meta.aliases = ov.aliases
  return meta
}

/**
 * 合并 generated 与 override：
 * 1) generated 每条应用同 id override（深合并）；
 * 2) override 中 generated 没有的 id 作为 standalone 追加。
 */
export function mergeModelMeta(
  generated: ModelMeta[],
  overrides: Record<string, ModelOverride>,
): ModelMeta[] {
  const merged = generated.map((m) => (overrides[m.id] ? applyOverride(m, overrides[m.id]!) : m))
  const generatedIds = new Set(generated.map((m) => m.id))
  for (const [id, ov] of Object.entries(overrides)) {
    // noUncheckedIndexedAccess: 元组解构推断为 T | undefined；ov 守卫收窄为 ModelOverride。
    if (ov && !generatedIds.has(id)) merged.push(overrideToStandalone(id, ov))
  }
  return merged
}
