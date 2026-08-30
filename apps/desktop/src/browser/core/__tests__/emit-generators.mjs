// 临时生成脚本:从 runtime-exact 文件提取字节恒定字符串,emit generators.ts 的字面量段。
// 生成完成后删除本脚本。
import fs from "node:fs"

const DIR = "D:/workspace/projects/ai-projects/lume/.zcode/analysis/extracted/injected-scripts/runtime-exact"
const OUT = "D:/workspace/projects/ai-projects/lume-browser-align/apps/desktop/src/browser/core/executor/injecteds/generated-literals.ts"

const read = (name) => fs.readFileSync(`${DIR}/${name}`, "utf8")

// ── SNAPSHOT_SCRIPT 主体(去掉参数化前缀) ─────────────────────────────
const snapshotFull = read("SNAPSHOT_SCRIPT(max=200,hidden=false).js")
const snapshotHead = "(function(){var MAX=200;var DOM_MAX=300;var INCLUDE_HIDDEN=false"
if (!snapshotFull.startsWith(snapshotHead)) throw new Error("SNAPSHOT prefix mismatch")
const snapshotBody = snapshotFull.slice(snapshotHead.length)
if (!snapshotBody.startsWith(";var ACTION_SEL=")) throw new Error("SNAPSHOT body mismatch")

// ── ELEMENT_AT_POINT_SCRIPT 主体 ────────────────────────────────────
const elementFull = read("ELEMENT_AT_POINT_SCRIPT(x,y).js")
const elementHead = "(function(){var el=document.elementFromPoint(640,360)"
if (!elementFull.startsWith(elementHead)) throw new Error("ELEMENT prefix mismatch")
const elementBody = elementFull.slice(elementHead.length)
if (!elementBody.startsWith(";if(!el")) throw new Error("ELEMENT body mismatch")

// ── Fj 文本粘贴页函数(按 token 拆为 head/token/tail) ─────────────────
const fjFull = read("Fj.runtime.js")
const TOKEN = "__zcodeIabInputTargetToken"
const fjTokenAt = fjFull.indexOf(`?.${TOKEN}!==`)
if (fjTokenAt < 0) throw new Error("Fj token marker not found")
const fjHead = fjFull.slice(0, fjTokenAt + 2)
const fjTail = fjFull.slice(fjTokenAt + 2 + TOKEN.length)
if (!fjHead.endsWith("?.")) throw new Error("Fj head mismatch")
if (!fjTail.startsWith("!==")) throw new Error("Fj tail mismatch")

// ── playwright 隔离世界 runtime 函数(原 fn.toString() 结果) ─────────
const pleWrapped = read("elementInfoRuntime.exact.js")
const ihWrapped = read("overlayRuntime.exact.js")
for (const [name, content] of [["ple", pleWrapped], ["IH", ihWrapped]]) {
  if (!content.startsWith("(function ") || !content.endsWith(")")) throw new Error(`${name} wrapper mismatch`)
}
const pleFn = pleWrapped.slice(1, -1)
const ihFn = ihWrapped.slice(1, -1)
if (!pleFn.startsWith("function ple(e){") || !pleFn.endsWith("}")) throw new Error("ple fn mismatch")
if (!ihFn.startsWith("function IH(e){") || !ihFn.endsWith("}")) throw new Error("IH fn mismatch")

const q = (s) => JSON.stringify(s)

const fjLines = fjHead.split("\n")
// head 最后一行是以 "?." 结尾的部分行(与 token 同行),单独存放。
const fjHeadCompleteLines = fjLines.slice(0, -1)
const fjHeadLastLine = fjLines[fjLines.length - 1]
if (!fjHeadLastLine.endsWith("?.")) throw new Error("Fj head last line mismatch")
const tailLines = fjTail.split("\n")
const tokenLineExpr = `INPUT_TARGET_TOKEN_FIELD + ${q(tailLines[0])}`

const content = `/**
 * 注入脚本字节恒定字面量 —— 由 runtime-exact 提取文件逐字节生成(勿手改)。
 *
 * 来源:
 *   - SNAPSHOT_SCRIPT 主体 ← injected-scripts/runtime-exact/SNAPSHOT_SCRIPT(max=200,hidden=false).js
 *     (自 ";var ACTION_SEL=" 起的常量尾部;MAX/DOM_MAX/INCLUDE_HIDDEN 前缀由 generators.ts 插值)
 *   - ELEMENT_AT_POINT 主体 ← runtime-exact/ELEMENT_AT_POINT_SCRIPT(x,y).js
 *     (自 elementFromPoint(...) 之后的常量尾部)
 *   - Fj 粘贴页函数 ← runtime-exact/Fj.runtime.js(按 di token 位拆分插值)
 *   - elementInfoRuntime/overlayRuntime ← runtime-exact/*.exact.js
 *     (ZCode 经 fn.toString() 序列化;Bun 的 TS 转译会改写函数体字节,
 *      故以字符串常量保存序列化结果,序列化输出与 yM 逐字节一致)
 *
 * 修改注入脚本时必须同步更新 runtime-exact 参照与生成脚本。
 */

/** ZCode 原名 di:输入目标 token 的元素属性字段名。 */
export const INPUT_TARGET_TOKEN_FIELD = ${q(TOKEN)}

/** SNAPSHOT_SCRIPT 常量尾部(不含参数化前缀,以 ";var ACTION_SEL=" 起)。 */
export const SNAPSHOT_SCRIPT_BODY = ${q(snapshotBody)}

/** ELEMENT_AT_POINT_SCRIPT 常量尾部(不含坐标前缀,以 ";if(!el" 起)。 */
export const ELEMENT_AT_POINT_SCRIPT_BODY = ${q(elementBody)}

/** Fj 文本粘贴页函数头部完整行(至 token 所在行的上一行,按 LF 分行)。 */
export const FJ_RUNTIME_HEAD_LINES: readonly string[] = [
${fjHeadCompleteLines.map((l) => "  " + q(l) + ",").join("\n")}
]

/** Fj token 所在行的部分行(以 "?." 结尾,与 INPUT_TARGET_TOKEN_FIELD 同行拼接)。 */
export const FJ_RUNTIME_HEAD_LAST_LINE = ${q(fjHeadLastLine)}

/** Fj token 插值点之后的首行(以 "!==" 起,与 INPUT_TARGET_TOKEN_FIELD 拼接)。 */
export const FJ_RUNTIME_TAIL_FIRST_LINE = ${q(tailLines[0])}

/** Fj 文本粘贴页函数尾部(首行之后,按 LF 分行)。 */
export const FJ_RUNTIME_TAIL_LINES: readonly string[] = [
${tailLines.slice(1).map((l) => "  " + q(l) + ",").join("\n")}
]

/** ZCode 原名 ple(elementInfoRuntime)的 fn.toString() 序列化字节。 */
export const ELEMENT_INFO_RUNTIME_FN_SOURCE = ${q(pleFn)}

/** ZCode 原名 IH(overlayRuntime)的 fn.toString() 序列化字节。 */
export const OVERLAY_RUNTIME_FN_SOURCE = ${q(ihFn)}
`

fs.mkdirSync(`${OUT}/..`, { recursive: true })
fs.writeFileSync(OUT, content, "utf8")
console.log("written", OUT, content.length, "chars")
console.log("snapshotBody:", snapshotBody.length, "elementBody:", elementBody.length, "fjHead lines:", fjLines.length, "fjTail lines:", tailLines.length)
console.log("fj token line:", JSON.stringify(tailLines[0]))
