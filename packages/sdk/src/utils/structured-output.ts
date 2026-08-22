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
    // Fall through: output wrapped in prose is recovered by extracting the
    // first balanced JSON object below (#318).
  }

  const candidate = extractFirstBalancedJsonObject(trimmed)
  if (!candidate) return undefined

  try {
    return JSON.parse(candidate)
  } catch {
    return undefined
  }
}

/**
 * Extract the first balanced top-level `{...}` block from free-form text,
 * skipping braces inside string literals and honoring escape sequences (#318).
 */
function extractFirstBalancedJsonObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start === -1) return undefined

  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return undefined
}
