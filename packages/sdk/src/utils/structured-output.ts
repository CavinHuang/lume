import type { OutputFormat } from '../types.js'

export function buildStructuredOutputInstruction(
  jsonSchema?: Record<string, unknown>,
  outputFormat?: OutputFormat,
): string {
  const schema = outputFormat?.schema || jsonSchema
  if (!schema) return ''

  return [
    'Return the final answer as valid JSON matching this schema.',
    'Do not wrap the JSON in markdown fences.',
    JSON.stringify(schema, null, 2),
  ].join('\n')
}

export function parseStructuredOutput(
  text: string,
  jsonSchema?: Record<string, unknown>,
  outputFormat?: OutputFormat,
): unknown {
  if (!jsonSchema && !outputFormat) return undefined

  const trimmed = text.trim()
  if (!trimmed) return undefined

  const raw = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}
