import type { InfographicOptions, SyntaxParseResult, ThemeConfig } from '@antv/infographic'

export const INFOGRAPHIC_MAX_SYNTAX_BYTES = 64 * 1024
export const LUME_INFOGRAPHIC_FONT_FAMILY = '"Geist Variable", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'

const SAFE_ICON_PATTERN = /^[a-z][a-z0-9]*(?:[ -][a-z0-9]+){0,2}$/
const SAFE_COLOR_PATTERN = /^#[0-9a-f]{3,8}$/i
const SAFE_THEMES = new Set(['light', 'dark', 'hand-drawn'])
const SAFE_DATA_ARRAY_KEYS = ['items', 'lists', 'sequences', 'compares', 'nodes', 'values'] as const
const REPAIRABLE_KEYS = new Set([
  'id', 'label', 'desc', 'group', 'category', 'value', 'icon', 'children',
  'from', 'to', 'direction', 'showArrow', 'arrowType', 'lineStyle', 'root',
  'relations', 'items', 'lists', 'sequences', 'compares', 'nodes', 'values',
  'title', 'order', 'colorPrimary', 'colorBg', 'palette', 'stylize', 'type',
])
const ARRAY_CONTAINER_KEYS = new Set([...SAFE_DATA_ARRAY_KEYS, 'children', 'relations'])

type InfographicData = NonNullable<InfographicOptions['data']>
type InfographicDatum = Record<string, unknown>

export interface InfographicSyntaxRuntime {
  parseSyntax: (syntax: string) => SyntaxParseResult
  getTemplate: (name: string) => unknown
}

export interface PreparedInfographic {
  syntax: string
  options: Partial<InfographicOptions>
  title: string
  warnings: string[]
}

export interface PrepareInfographicOptions {
  enableIcons: boolean
  allowIncomplete?: boolean
}

export class InfographicSyntaxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InfographicSyntaxError'
  }
}

export function prepareInfographic(
  syntax: string,
  runtime: InfographicSyntaxRuntime,
  prepareOptions: PrepareInfographicOptions,
): PreparedInfographic {
  const normalized = syntax.trim()
  if (!normalized) throw new InfographicSyntaxError('信息图 DSL 为空')
  if (new TextEncoder().encode(normalized).byteLength > INFOGRAPHIC_MAX_SYNTAX_BYTES) {
    throw new InfographicSyntaxError('信息图 DSL 超过 64 KiB 限制')
  }

  let effectiveSyntax = normalized
  let parsed = runtime.parseSyntax(effectiveSyntax)
  if (parsed.errors.length > 0) {
    const repaired = repairInfographicSyntax(effectiveSyntax)
    if (repaired) {
      const repairedParsed = runtime.parseSyntax(repaired)
      if (repairedParsed.errors.length === 0) {
        effectiveSyntax = repaired
        parsed = repairedParsed
      }
    }
  }
  if (parsed.errors.length > 0) {
    throw new InfographicSyntaxError(formatSyntaxError(parsed.errors[0]))
  }

  const template = parsed.options.template?.trim()
  if ((!template && !prepareOptions.allowIncomplete) || (template && !runtime.getTemplate(template))) {
    throw new InfographicSyntaxError(template ? `未知的信息图模板：${template}` : '信息图必须指定已注册模板')
  }
  if (parsed.options.design) {
    throw new InfographicSyntaxError('v1 不允许自定义 design')
  }

  const warnings = parsed.warnings.map(formatSyntaxError)
  if (effectiveSyntax !== normalized) warnings.push('已自动修复 YAML 风格字段和列表缩进')
  if (parsed.options.width !== undefined || parsed.options.height !== undefined) {
    warnings.push('已忽略 DSL 中的宽高，由 Lume 容器控制')
  }

  const data = parsed.options.data
    ? sanitizeData(parsed.options.data, prepareOptions.enableIcons, warnings, prepareOptions.allowIncomplete === true)
    : undefined
  if (!data && !prepareOptions.allowIncomplete) throw new InfographicSyntaxError('信息图必须包含 data')
  const theme = sanitizeTheme(parsed.options.theme)
  const themeConfig = withBundledTypography(sanitizeThemeConfig(parsed.options.themeConfig))
  const title = typeof data?.title === 'string' && data.title.trim() ? data.title.trim() : 'lume-infographic'

  return {
    syntax: effectiveSyntax,
    options: {
      ...(template ? { template } : {}),
      ...(data ? { data } : {}),
      ...(theme ? { theme } : {}),
      themeConfig,
      editable: false,
    },
    title,
    warnings,
  }
}

/**
 * Repairs the common model failure mode where AntV syntax is emitted as
 * YAML-like `key: value` and list indentation is lost below array containers.
 * It does not invent fields or data; the repaired result still passes the
 * normal parser, template allowlist, and resource sanitizer before rendering.
 */
export function repairInfographicSyntax(syntax: string): string | null {
  const lines = syntax.split(/\r?\n/)
  const listStack: Array<{ rawIndent: number; outputIndent: number }> = []
  let pendingListIndent: number | null = null
  let changed = false

  const repaired = lines.map((line) => {
    if (!line.trim()) return line
    const rawIndent = line.match(/^ */)?.[0].length ?? 0
    const trimmed = line.trim()
    const listMatch = trimmed.match(/^-\s+([A-Za-z][\w-]*):(?:\s*(.*))?$/)
    const fieldMatch = trimmed.match(/^([A-Za-z][\w-]*):(?:\s*(.*))?$/)
    const match = listMatch ?? fieldMatch
    const key = match?.[1]
    const value = match?.[2] ?? ''
    const isListItem = listMatch !== null
    const normalizedContent = key && REPAIRABLE_KEYS.has(key)
      ? `${isListItem ? '- ' : ''}${key}${value ? ` ${value}` : ''}`
      : trimmed
    if (normalizedContent !== trimmed) changed = true

    if (rawIndent === 0 && !isListItem) {
      listStack.length = 0
      pendingListIndent = null
      return normalizedContent
    }

    if (isListItem) {
      let outputIndent = rawIndent
      if (pendingListIndent !== null) {
        outputIndent = pendingListIndent
        listStack.push({ rawIndent, outputIndent })
        pendingListIndent = null
      } else {
        while (listStack.length > 1 && rawIndent < listStack[listStack.length - 1]!.rawIndent) listStack.pop()
        const context = listStack[listStack.length - 1]
        if (context && rawIndent === context.rawIndent) outputIndent = context.outputIndent
      }
      if (outputIndent !== rawIndent) changed = true
      return `${' '.repeat(outputIndent)}${normalizedContent}`
    }

    const context = listStack[listStack.length - 1]
    const outputIndent = context && rawIndent > context.rawIndent
      ? context.outputIndent + 2
      : rawIndent
    if (outputIndent !== rawIndent) changed = true
    if (key && ARRAY_CONTAINER_KEYS.has(key)) pendingListIndent = outputIndent + 2
    return `${' '.repeat(outputIndent)}${normalizedContent}`
  }).join('\n')

  return changed ? repaired : null
}

function withBundledTypography(themeConfig: ThemeConfig | undefined): ThemeConfig {
  return {
    ...themeConfig,
    base: {
      text: {
        'font-family': LUME_INFOGRAPHIC_FONT_FAMILY,
      },
    },
  }
}

function sanitizeData(
  input: InfographicOptions['data'] | undefined,
  enableIcons: boolean,
  warnings: string[],
  allowIncomplete = false,
): InfographicData {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InfographicSyntaxError('信息图必须包含 data')
  }
  const source = input as Record<string, unknown>
  rejectForbiddenDataFields(source)

  const output: Record<string, unknown> = {}
  copyString(source, output, 'title')
  copyString(source, output, 'desc')

  for (const key of SAFE_DATA_ARRAY_KEYS) {
    const value = source[key]
    if (value === undefined) continue
    if (!Array.isArray(value)) throw new InfographicSyntaxError(`data.${key} 必须是列表`)
    output[key] = value.map((item, index) => sanitizeDatum(item, enableIcons, warnings, `data.${key}[${index}]`))
  }

  if (source.root !== undefined) {
    output.root = sanitizeDatum(source.root, enableIcons, warnings, 'data.root')
  }
  if (source.relations !== undefined) {
    if (!Array.isArray(source.relations)) throw new InfographicSyntaxError('data.relations 必须是列表')
    output.relations = source.relations.map((relation, index) => sanitizeRelation(relation, `data.relations[${index}]`))
  }
  if (source.order === 'asc' || source.order === 'desc') output.order = source.order

  const hasVisualData = SAFE_DATA_ARRAY_KEYS.some((key) => Array.isArray(output[key]) && (output[key] as unknown[]).length > 0)
    || output.root !== undefined
  if (!hasVisualData && !allowIncomplete) throw new InfographicSyntaxError('信息图 data 至少需要一个数据项')

  return output as InfographicData
}

function sanitizeDatum(
  input: unknown,
  enableIcons: boolean,
  warnings: string[],
  path: string,
): InfographicDatum {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InfographicSyntaxError(`${path} 必须是对象`)
  }
  const source = input as Record<string, unknown>
  rejectForbiddenDataFields(source, path)
  const output: InfographicDatum = {}

  for (const key of ['id', 'label', 'desc', 'group', 'category'] as const) copyString(source, output, key)
  if (typeof source.value === 'number' && Number.isFinite(source.value)) output.value = source.value
  else if (typeof source.value === 'string') output.value = source.value

  if (source.icon !== undefined) {
    if (typeof source.icon !== 'string') throw new InfographicSyntaxError(`${path}.icon 只允许通用英文关键词`)
    const icon = source.icon.trim().toLowerCase()
    if (looksLikeExternalResource(icon)) throw new InfographicSyntaxError(`${path}.icon 不允许 URL、data URI、ref 或 SVG`)
    if (!SAFE_ICON_PATTERN.test(icon) || icon.length > 64) {
      warnings.push(`${path}.icon 已移除：只允许不超过三个英文单词`)
    } else if (enableIcons) {
      output.icon = icon
    }
  }

  if (source.children !== undefined) {
    if (!Array.isArray(source.children)) throw new InfographicSyntaxError(`${path}.children 必须是列表`)
    output.children = source.children.map((child, index) => sanitizeDatum(child, enableIcons, warnings, `${path}.children[${index}]`))
  }

  return output
}

function sanitizeRelation(input: unknown, path: string): InfographicDatum {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InfographicSyntaxError(`${path} 必须是对象`)
  }
  const source = input as Record<string, unknown>
  rejectForbiddenDataFields(source, path)
  const output: InfographicDatum = {}
  for (const key of ['id', 'from', 'to', 'label'] as const) copyString(source, output, key)
  if (source.direction === 'forward' || source.direction === 'both' || source.direction === 'none') output.direction = source.direction
  if (typeof source.showArrow === 'boolean') output.showArrow = source.showArrow
  if (source.arrowType === 'arrow' || source.arrowType === 'triangle' || source.arrowType === 'diamond') output.arrowType = source.arrowType
  if (source.lineStyle === 'solid' || source.lineStyle === 'dashed') output.lineStyle = source.lineStyle
  if (typeof output.from !== 'string' || typeof output.to !== 'string') {
    throw new InfographicSyntaxError(`${path} 必须包含 from 和 to`)
  }
  return output
}

function sanitizeTheme(theme: string | undefined): string | undefined {
  if (!theme) return undefined
  if (!SAFE_THEMES.has(theme)) throw new InfographicSyntaxError(`不允许的主题：${theme}`)
  return theme
}

function sanitizeThemeConfig(input: ThemeConfig | undefined): ThemeConfig | undefined {
  if (!input) return undefined
  const output: ThemeConfig = {}
  if (input.colorPrimary !== undefined) output.colorPrimary = sanitizeColor(input.colorPrimary, 'theme.colorPrimary')
  if (input.colorBg !== undefined) output.colorBg = sanitizeColor(input.colorBg, 'theme.colorBg')
  if (input.palette !== undefined) {
    if (Array.isArray(input.palette)) {
      output.palette = input.palette.map((color, index) => sanitizeColor(color, `theme.palette[${index}]`))
    } else if (typeof input.palette === 'string' && SAFE_COLOR_PATTERN.test(input.palette)) {
      output.palette = input.palette
    } else {
      throw new InfographicSyntaxError('theme.palette 只允许十六进制颜色')
    }
  }
  if (input.stylize !== undefined && input.stylize !== null) {
    const stylize = input.stylize
    if (stylize.type !== 'rough') throw new InfographicSyntaxError('theme.stylize 仅允许 rough')
    output.stylize = { type: 'rough' }
  }
  return Object.keys(output).length > 0 ? output : undefined
}

function sanitizeColor(value: unknown, path: string): string {
  if (typeof value !== 'string' || !SAFE_COLOR_PATTERN.test(value)) {
    throw new InfographicSyntaxError(`${path} 只允许十六进制颜色`)
  }
  return value
}

function rejectForbiddenDataFields(source: Record<string, unknown>, path = 'data'): void {
  if ('illus' in source) throw new InfographicSyntaxError(`${path}.illus 不受支持`)
  if ('attributes' in source) throw new InfographicSyntaxError(`${path}.attributes 不受支持`)
}

function looksLikeExternalResource(value: string): boolean {
  return /^(?:https?:|data:|ref:|<svg|<symbol)/i.test(value) || value.includes('://')
}

function copyString(source: Record<string, unknown>, output: Record<string, unknown>, key: string): void {
  if (typeof source[key] === 'string') output[key] = source[key]
}

function formatSyntaxError(error: { line: number; message: string }): string {
  return `第 ${error.line} 行：${error.message}`
}
