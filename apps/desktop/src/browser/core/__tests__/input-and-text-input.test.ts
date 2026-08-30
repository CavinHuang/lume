/**
 * 输入原语与文本注入测试 —— KEY_TABLE 完整性(02 源 Dj 表逐条目)与
 * Fj 粘贴页函数字节等价(runtime-exact 参照)。
 *
 * 参照目录解析顺序与 injected-generators.test.ts 一致:
 *   1. 环境变量 ZCODE_RUNTIME_EXACT_DIR;
 *   2. ZCode 逆向提取目录(.zcode/analysis/extracted/injected-scripts/runtime-exact);
 *   3. 仓库内字节副本 fixtures/runtime-exact。
 */
import { existsSync } from "node:fs"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { asModifier, keyDefinition, KEY_TABLE, modifiersBitmask, normalizeCuaKey } from "../input"
import { clipboardItems, pasteTextPageFunction, INPUT_TARGET_TOKEN_FIELD } from "../injected/text-input"

const PRIMARY_DIR = "D:/workspace/projects/ai-projects/lume/.zcode/analysis/extracted/injected-scripts/runtime-exact"
const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/runtime-exact", import.meta.url))

const referenceDir = process.env.ZCODE_RUNTIME_EXACT_DIR
  ?? (existsSync(PRIMARY_DIR) ? PRIMARY_DIR : FIXTURE_DIR)

function readExact(name: string): string {
  return readFileSync(join(referenceDir, name), "utf8")
}

describe("input 键表(ZCode 原名 Dj/gde/hde)", () => {
  test("KEY_TABLE 含 Dj 完整 10 条目", () => {
    // 02-execution-engine.source.js 的 Dj 表恰好 10 条(Enter/Tab/Escape/
    // Backspace/Delete/Arrow×4/Space),无更多条目。
    expect(Object.keys(KEY_TABLE).sort()).toEqual([
      "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp",
      "Backspace", "Delete", "Enter", "Escape", "Space", "Tab",
    ])
  })

  test("KEY_TABLE 关键条目 key/code/VK 与 Dj 字节一致", () => {
    expect(KEY_TABLE.Enter).toEqual({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
    expect(KEY_TABLE.Space).toEqual({ key: " ", code: "Space", windowsVirtualKeyCode: 32 })
    expect(KEY_TABLE.Escape).toEqual({ key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
    expect(KEY_TABLE.Backspace).toEqual({ key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 })
  })

  test("keyDefinition 修饰键/单字符/数字兜底(wde)", () => {
    expect(keyDefinition("Shift")).toEqual({ key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 })
    expect(keyDefinition("a")).toEqual({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65 })
    expect(keyDefinition("5")).toEqual({ key: "5", code: "Digit5", windowsVirtualKeyCode: 53 })
    expect(keyDefinition(";")).toEqual({ key: ";" })
  })

  test("normalizeCuaKey/asModifier/modifiersBitmask(yde/$j/Rn)", () => {
    expect(normalizeCuaKey(" ctrl ")).toBe("Control")
    expect(normalizeCuaKey("esc")).toBe("Escape")
    expect(normalizeCuaKey("left")).toBe("ArrowLeft")
    expect(normalizeCuaKey("F1")).toBe("F1")
    expect(asModifier("Meta")).toBe("Meta")
    expect(asModifier("ctrl")).toBeUndefined()
    expect(modifiersBitmask(["Control", "Shift"])).toBe(2 | 8)
    expect(modifiersBitmask(undefined)).toBe(0)
  })
})

describe("Fj 文本粘贴页函数字节等价(runtime-exact)", () => {
  test("pasteTextPageFunction() ≡ Fj.runtime.js(含 di token 插值)", () => {
    const runtime = readExact("Fj.runtime.js")
    expect(pasteTextPageFunction()).toBe(runtime)
    // token 必须经 INPUT_TARGET_TOKEN_FIELD 插值出现恰好一次
    expect(runtime.split(INPUT_TARGET_TOKEN_FIELD).length - 1).toBe(1)
  })

  test("clipboardItems(Ide) 带 entries/presentation_style 包装层", () => {
    // Fj 按 item.entries 消费;包装层缺失会使 textForMime/setData 失效。
    // Ide:条目聚进单组 entries,富文本经 escapeHtml 后追加。
    expect(clipboardItems("a\nb", false)).toEqual([
      { entries: [{ mime_type: "text/plain", text: "a\nb" }], presentation_style: "unspecified" },
    ])
    expect(clipboardItems("x", true)).toEqual([
      {
        entries: [
          { mime_type: "text/plain", text: "x" },
          { mime_type: "text/html", text: "x" },
        ],
        presentation_style: "unspecified",
      },
    ])
  })
})
