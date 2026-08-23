/**
 * Deterministic JSON serialization used for equality signatures and content
 * hashes: object keys are sorted ascending (code-unit order, independent of
 * the runtime locale), `undefined` valued properties are dropped, and arrays
 * keep their order (position-sensitive sequences must hash differently).
 *
 * Consumers must treat the exact byte output as load-bearing (persisted
 * hashes, repeat-guard signatures); changes here are breaking by definition.
 */
export function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? String(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`
  }
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key])}`)
    .join(',')}}`
}
