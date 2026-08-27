/**
 * 键序无关的 JSON 比较基准（#758）。
 * settings_updated 的 changedKeys 审计此前用裸 JSON.stringify 比较，
 * 嵌套对象键序不同即报假阳性变更键。
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}
