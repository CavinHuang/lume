/**
 * 页面快照 —— SNAPSHOT_SCRIPT 执行与结果校验。
 *
 * 来源:D:\workspace\projects\ai-projects\lume\.zcode\analysis\extracted\
 *       02-execution-engine.source.js(handleSnapshot)
 *       injected-scripts/runtime-exact/SNAPSHOT_SCRIPT(max=200,hidden=false).js
 *
 * ZCode 原名对照:
 *   yH → handleSnapshot    x$ → (zod schema,见 PortingGap)
 *   Rj → snapshotScript(见 injecteds/generators.ts)
 *
 * PortingGap:ZCode 的 x$ zod schema 未在提取源中,parseSnapshotResult 按
 * SNAPSHOT_SCRIPT 的返回契约重建(shape {url,title,dom,domTruncated,elements,
 * truncated} + 元素/DOM 节点字段类型),失败路径语义一致(issues[0].message)。
 *
 * 语义偏差:无。
 */
import type { BrowserCommandResult, ControlledView } from "../types"
import { executionError, type CommandDone, type SnapshotCommandParams } from "./dispatcher"
import { snapshotScript } from "./injecteds/generators"

/** SNAPSHOT_SCRIPT 返回的可交互元素。 */
export interface SnapshotElement {
  ref: string
  tag: string
  selector: string
  xpath: string
  rect: { x: number; y: number; width: number; height: number }
  inViewport: boolean
  parentRef?: string
  role?: string
  name?: string
  text?: string
  attributes?: Record<string, string>
  value?: string
  disabled?: boolean
  checked?: boolean
}

/** SNAPSHOT_SCRIPT 返回的 DOM 节点清单项。 */
export interface SnapshotDomNode {
  tag: string
  depth: number
  inViewport: boolean
  ref?: string
  role?: string
  name?: string
  text?: string
  attributes?: Record<string, string>
}

/** SNAPSHOT_SCRIPT 返回的快照结果(shape 与 ZCode x$ 对应)。 */
export interface SnapshotResult {
  url: string
  title: string
  dom: SnapshotDomNode[]
  domTruncated: boolean
  elements: SnapshotElement[]
  truncated: boolean
}

export type ParseFailure = { success: false; error: { issues: Array<{ message: string }> } }
export type ParseSuccess<T> = { success: true; data: T }
export type ParseResult<T> = ParseSuccess<T> | ParseFailure

/**
 * 失败分支类型守卫。(tsconfig 关闭 strictNullChecks 时布尔字面量判别联合
 * 会被加宽,三元/!parsed.success 窄化不可靠,故用谓词守卫。)
 */
export function isParseFailure<T>(result: ParseResult<T>): result is ParseFailure {
  return result.success !== true
}

const isString = (value: unknown): value is string => typeof value === "string"
const isNumber = (value: unknown): value is number => typeof value === "number"
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean"
const failure = (message: string): ParseFailure => ({ success: false, error: { issues: [{ message }] } })

/** attributes 可选映射(全部字符串值)。 */
function parseAttributes(value: unknown): boolean {
  if (value === undefined) return true
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every(isString)
}

/** 校验元素公共字段(ref/tag/selector/xpath/rect/inViewport + 可选字段)。 */
function parseElementShape(record: Record<string, unknown>, prefix: string): ParseFailure | null {
  for (const key of ["ref", "tag", "selector", "xpath"] as const) {
    if (!isString(record[key])) return failure(`${prefix}.${key}: expected string`)
  }
  const rect = record.rect
  if (!rect || typeof rect !== "object") return failure(`${prefix}.rect: expected object`)
  for (const key of ["x", "y", "width", "height"] as const) {
    if (!isNumber((rect as Record<string, unknown>)[key])) return failure(`${prefix}.rect.${key}: expected number`)
  }
  if (!isBoolean(record.inViewport)) return failure(`${prefix}.inViewport: expected boolean`)
  if (record.parentRef !== undefined && !isString(record.parentRef)) return failure(`${prefix}.parentRef: expected string`)
  if (record.role !== undefined && !isString(record.role)) return failure(`${prefix}.role: expected string`)
  if (record.name !== undefined && !isString(record.name)) return failure(`${prefix}.name: expected string`)
  if (record.text !== undefined && !isString(record.text)) return failure(`${prefix}.text: expected string`)
  if (!parseAttributes(record.attributes)) return failure(`${prefix}.attributes: expected record of strings`)
  if (record.value !== undefined && !isString(record.value)) return failure(`${prefix}.value: expected string`)
  if (record.disabled !== undefined && !isBoolean(record.disabled)) return failure(`${prefix}.disabled: expected boolean`)
  if (record.checked !== undefined && !isBoolean(record.checked)) return failure(`${prefix}.checked: expected boolean`)
  return null
}

/**
 * PortingGap(重建 x$):校验 SNAPSHOT_SCRIPT 返回形状。
 * {url,title,dom,domTruncated,elements,truncated},dom/elements 逐项校验。
 */
export function parseSnapshotResult(value: unknown): ParseResult<SnapshotResult> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return failure("snapshot: expected object")
  const record = value as Record<string, unknown>
  if (!isString(record.url)) return failure("url: expected string")
  if (!isString(record.title)) return failure("title: expected string")
  if (!isBoolean(record.domTruncated)) return failure("domTruncated: expected boolean")
  if (!isBoolean(record.truncated)) return failure("truncated: expected boolean")
  if (!Array.isArray(record.dom)) return failure("dom: expected array")
  for (const [index, node] of record.dom.entries()) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return failure(`dom[${index}]: expected object`)
    const nodeRecord = node as Record<string, unknown>
    if (!isString(nodeRecord.tag)) return failure(`dom[${index}].tag: expected string`)
    if (!isNumber(nodeRecord.depth)) return failure(`dom[${index}].depth: expected number`)
    if (!isBoolean(nodeRecord.inViewport)) return failure(`dom[${index}].inViewport: expected boolean`)
    if (nodeRecord.ref !== undefined && !isString(nodeRecord.ref)) return failure(`dom[${index}].ref: expected string`)
    if (nodeRecord.role !== undefined && !isString(nodeRecord.role)) return failure(`dom[${index}].role: expected string`)
    if (nodeRecord.name !== undefined && !isString(nodeRecord.name)) return failure(`dom[${index}].name: expected string`)
    if (nodeRecord.text !== undefined && !isString(nodeRecord.text)) return failure(`dom[${index}].text: expected string`)
    if (!parseAttributes(nodeRecord.attributes)) return failure(`dom[${index}].attributes: expected record of strings`)
  }
  if (!Array.isArray(record.elements)) return failure("elements: expected array")
  for (const [index, element] of record.elements.entries()) {
    if (!element || typeof element !== "object" || Array.isArray(element)) return failure(`elements[${index}]: expected object`)
    const shapeFailure = parseElementShape(element as Record<string, unknown>, `elements[${index}]`)
    if (shapeFailure) return shapeFailure
  }
  return { success: true, data: value as SnapshotResult }
}

/**
 * ZCode 原名 yH/handleSnapshot:执行 SNAPSHOT_SCRIPT(maxElements/includeHidden)
 * 并校验结果形状;失败报 execution_error。
 */
export async function handleSnapshot(view: ControlledView, params: SnapshotCommandParams, done: CommandDone): Promise<BrowserCommandResult> {
  const result = await view.webContents.executeJavaScript(snapshotScript(params.maxElements, params.includeHidden))
  const parsed = parseSnapshotResult(result)
  if (isParseFailure(parsed)) {
    return done({
      ok: false,
      error: {
        code: "execution_error",
        message: `invalid snapshot result shape: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      },
    })
  }
  return done({
    ok: true,
    snapshot: parsed.data,
  })
}
