/**
 * playwright 注入脚本加载器 —— 从 monorepo node_modules 的 playwright-core
 * 中解码官方 injectedScriptSource(选择器引擎来自官方注入脚本,本工程不自行
 * 重实现选择器解析)。
 *
 * 来源:D:\workspace\projects\ai-projects\lume\.zcode\analysis\extracted\
 *       02-execution-engine.source.js [SECTION] playwright 注入脚本加载与隔离世界
 *
 * ZCode 原名对照:
 *   Fg  → getPlaywrightInjectedScriptSource(惰性解析一次后模块级缓存)
 *   Kde → createRequire(import.meta.url)
 *   qde → SOURCE_ASSIGNMENT_PATTERN(`const source\s*=\s*`)
 *   Vde → readStringLiteralEnd(字符串字面量终结扫描)
 *   lM  → cachedInjectedScriptSource(模块级缓存)
 *   Jde → DOM_SNAPSHOT_WORLD_NAME(ZCode "zcode-playwright-dom-snapshot",
 *         供 PlaywrightDomSnapshotSession 使用,常量随源码落于本文件)
 *   Wg/li → PLAYWRIGHT_INJECTED_GLOBAL_FIELD("__zcodePlaywrightInjected",
 *         快照会话与 locator 会话共用同一全局注入字段)
 *
 * 语义偏差(已声明项):
 *   - 运行时解析路径:与 ZCode 相同,经 createRequire 从最近的 node_modules
 *     解析 playwright-core/package.json(Lume 侧由 monorepo 依赖装配提供)。
 *   - s(X,"name") 压缩器 displayName 元数据一律去除。
 */
import { readFileSync } from "fs"
import { createRequire } from "module"
import { dirname, join } from "path"
import { runInNewContext } from "vm"

/**
 * PortingGap:ZCode 以 require 形态解析打包内嵌的 playwright-core;Lume 保持
 * 同款 createRequire(import.meta.url).resolve —— 由 monorepo node_modules
 * 在运行时提供 playwright-core 依赖(未安装时按源码语义抛错)。
 */
const requireFromHere = createRequire(import.meta.url)

/** ZCode 原名 qde:注入脚本源赋值起始模式。 */
const SOURCE_ASSIGNMENT_PATTERN = /const source\s*=\s*/

/** ZCode 原名 lM:解码后的注入脚本模块级缓存(进程生命周期内只解析一次)。 */
let cachedInjectedScriptSource: string | undefined

/** 注入脚本完整性锚点 1:CommonJS 互操作导出行。 */
const INTEGRITY_EXPORT_MARKER = "module.exports = __toCommonJS(injectedScript_exports)"
/** 注入脚本完整性锚点 2:locator 快照所依赖的 API 名。 */
const INTEGRITY_API_MARKER = "incrementalAriaSnapshot"

/**
 * ZCode 原名 Vde/readStringLiteralEnd:从 from 起扫描字符串字面量(支持转义)
 * 的结束位置(闭引号后一位);引号缺失或未终结抛错。
 */
function readStringLiteralEnd(source: string, from: number): number {
  const quote = source[from]
  if (quote !== '"' && quote !== "'") {
    throw new Error("Playwright injected source assignment is not a string literal")
  }
  let escaped = false
  for (let index = from + 1; index < source.length; index += 1) {
    const character = source[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === "\\") {
      escaped = true
      continue
    }
    if (character === quote) return index + 1
  }
  throw new Error("Playwright injected source string literal is unterminated")
}

/**
 * ZCode 原名 Fg/getPlaywrightInjectedScriptSource:定位 playwright-core 的
 * lib/generated/injectedScriptSource.js,扫描 `const source = '...'` 字符串
 * 字面量,经 vm.runInNewContext(1s 超时)解码转义序列,做完整性校验
 * (导出行 + incrementalAriaSnapshot)后缓存返回。
 */
export function getPlaywrightInjectedScriptSource(): string {
  if (cachedInjectedScriptSource) return cachedInjectedScriptSource
  const packageJsonPath = requireFromHere.resolve("playwright-core/package.json")
  const injectedSourcePath = join(dirname(packageJsonPath), "lib", "generated", "injectedScriptSource.js")
  const raw = readFileSync(injectedSourcePath, "utf8")
  const match = SOURCE_ASSIGNMENT_PATTERN.exec(raw)
  if (!match) throw new Error("Unable to locate Playwright injected source assignment")
  const literalStart = match.index + match[0].length
  const literalEnd = readStringLiteralEnd(raw, literalStart)
  const literal = raw.slice(literalStart, literalEnd)
  const decoded = runInNewContext(literal, Object.create(null), { timeout: 1_000 })
  if (typeof decoded !== "string"
    || !decoded.includes(INTEGRITY_EXPORT_MARKER)
    || !decoded.includes(INTEGRITY_API_MARKER)) {
    throw new Error("Playwright injected source failed integrity checks")
  }
  cachedInjectedScriptSource = decoded
  return decoded
}

/** 隔离世界命名(ZCode Jde):PlaywrightDomSnapshotSession 专用。 */
export const DOM_SNAPSHOT_WORLD_NAME = "zcode-playwright-dom-snapshot"

/** ZCode 原名 Wg/li:注入 runtime 挂载的全局字段名(两会话共用)。 */
export const PLAYWRIGHT_INJECTED_GLOBAL_FIELD = "__zcodePlaywrightInjected"
