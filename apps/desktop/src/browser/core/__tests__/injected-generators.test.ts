/**
 * 注入脚本生成器字节等价测试 —— generators.ts 输出必须与 ZCode runtime-exact
 * 提取文件逐字节一致。
 *
 * 参照目录解析顺序:
 *   1. 环境变量 ZCODE_RUNTIME_EXACT_DIR;
 *   2. ZCode 逆向提取目录(.zcode/analysis/extracted/injected-scripts/runtime-exact);
 *   3. 仓库内字节副本 fixtures/runtime-exact(与 2 同步,防止提取目录缺失)。
 *
 * 提取时使用的参数(与参照文件对应):
 *   RESOLVE/CHECK/SELECT ref="e5";CHECK checked=true;SELECT values=[" option "];
 *   EVALUATE expr="1+1";ELEMENT_AT_POINT x=640,y=360;
 *   SNAPSHOT max=200,hidden=false。
 */
import { existsSync } from "node:fs"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  checkScript,
  elementAtPointScript,
  evaluateScript,
  pasteTextPageFunction,
  resolveScript,
  selectScript,
  snapshotScript,
  ELEMENT_INFO_RUNTIME_FN_SOURCE,
  OVERLAY_RUNTIME_FN_SOURCE,
  INPUT_TARGET_TOKEN_FIELD,
} from "../executor/injecteds/generators"
import { serializeRuntimeCall } from "../executor/element-info"

const PRIMARY_DIR = "D:/workspace/projects/ai-projects/lume/.zcode/analysis/extracted/injected-scripts/runtime-exact"
const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/runtime-exact", import.meta.url))

const referenceDir = process.env.ZCODE_RUNTIME_EXACT_DIR
  ?? (existsSync(PRIMARY_DIR) ? PRIMARY_DIR : FIXTURE_DIR)

function readExact(name: string): string {
  return readFileSync(join(referenceDir, name), "utf8")
}

/** 参照文件无尾部换行;读取时按原样比较(不作归一化)。 */
describe("注入脚本生成器字节等价(runtime-exact)", () => {
  test("resolveScript(ref) ≡ RESOLVE_SCRIPT", () => {
    expect(resolveScript("e5")).toBe(readExact("RESOLVE_SCRIPT(ref).js"))
  })

  test("checkScript(ref, true) ≡ CHECK_SCRIPT", () => {
    expect(checkScript("e5", true)).toBe(readExact("CHECK_SCRIPT(ref,checked).js"))
  })

  test("selectScript(ref, values) ≡ SELECT_SCRIPT", () => {
    expect(selectScript("e5", [" option "])).toBe(readExact("SELECT_SCRIPT(ref,values).js"))
  })

  test("evaluateScript(expr) ≡ EVALUATE_SCRIPT(含表达式后换行)", () => {
    expect(evaluateScript("1+1")).toBe(readExact("EVALUATE_SCRIPT(expr).js"))
  })

  test("elementAtPointScript(640, 360) ≡ ELEMENT_AT_POINT_SCRIPT", () => {
    expect(elementAtPointScript(640, 360)).toBe(readExact("ELEMENT_AT_POINT_SCRIPT(x,y).js"))
  })

  test("snapshotScript(200, false) ≡ SNAPSHOT_SCRIPT(max=200,hidden=false)", () => {
    expect(snapshotScript(200, false)).toBe(readExact("SNAPSHOT_SCRIPT(max=200,hidden=false).js"))
  })

  test("snapshotScript() 默认参数与 (200,false) 输出一致", () => {
    expect(snapshotScript()).toBe(snapshotScript(200, false))
  })

  test("pasteTextPageFunction() ≡ Fj.runtime(含 di token 插值)", () => {
    const runtime = readExact("Fj.runtime.js")
    expect(pasteTextPageFunction()).toBe(runtime)
    // token 必须经 INPUT_TARGET_TOKEN_FIELD 插值出现恰好一次
    expect(runtime.split(INPUT_TARGET_TOKEN_FIELD).length - 1).toBe(1)
  })

  test("serializeRuntimeCall 前缀 ≡ elementInfoRuntime.exact(fn.toString() 字节)", () => {
    expect(`(${ELEMENT_INFO_RUNTIME_FN_SOURCE})`).toBe(readExact("elementInfoRuntime.exact.js"))
  })

  test("serializeRuntimeCall 前缀 ≡ overlayRuntime.exact(fn.toString() 字节)", () => {
    expect(`(${OVERLAY_RUNTIME_FN_SOURCE})`).toBe(readExact("overlayRuntime.exact.js"))
  })

  test("serializeRuntimeCall 参数序列化符合 yM 形态", () => {
    expect(serializeRuntimeCall("function f(o){}", { x: 1, remove: false })).toBe('(function f(o){})({"x":1,"remove":false})')
  })
})

describe("生成器参数插值", () => {
  test("SNAPSHOT 参数插值仅影响 MAX/DOM_MAX/INCLUDE_HIDDEN 前缀", () => {
    const full = snapshotScript(200, false)
    const variant = snapshotScript(100, true)
    const bodyAt = full.indexOf(";var ACTION_SEL=")
    expect(bodyAt).toBeGreaterThan(0)
    expect(variant.slice(variant.indexOf(";var ACTION_SEL="))).toBe(full.slice(bodyAt))
    expect(variant.startsWith("(function(){var MAX=100;var DOM_MAX=300;var INCLUDE_HIDDEN=true;")).toBe(true)
  })

  test("SNAPSHOT 非法上限回落 200(floor 取整)", () => {
    expect(snapshotScript(Number.NaN)).toBe(snapshotScript(200, false))
    expect(snapshotScript(75.9).startsWith("(function(){var MAX=75;")).toBe(true)
  })

  test("ELEMENT_AT_POINT 坐标经 JSON.stringify 插值", () => {
    expect(elementAtPointScript(12, -3).startsWith("(function(){var el=document.elementFromPoint(12,-3);if(!el")).toBe(true)
  })

  test("CHECK_SCRIPT checked=false 写入字面 false", () => {
    expect(checkScript("e5", false).includes("var want=false;")).toBe(true)
  })

  test("EVALUATE_SCRIPT 表达式原样插值(非字符串化)", () => {
    expect(evaluateScript("document.title").includes(" return (document.title\n); })()")).toBe(true)
  })
})
