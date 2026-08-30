/**
 * locator 纯逻辑测试 —— 选择器/帧链拆分、按键解析、修饰键平台映射、
 * 可恢复竞态判定与 playwright 注入脚本源校验锚点。
 *
 * 来源:02-execution-engine.source.js [SECTION] IabPlaywrightLocatorSession
 * (cle/dle/CH/lle/ale)与 injected-loader.ts(Fg 完整性锚点/qde/Vde)。
 */
import { describe, expect, test } from "bun:test"
import {
  frameSegments,
  isRecoverableLocatorRace,
  modifierNames,
  pressParts,
  splitSelectorTokens,
} from "../executor/locator-session"

describe("splitSelectorTokens(cle)", () => {
  test("按 ' >> ' 拆分并裁剪空白", () => {
    expect(splitSelectorTokens("a >> b >> c")).toEqual(["a", "b", "c"])
  })

  test("引号内的 ' >> ' 不拆分", () => {
    expect(splitSelectorTokens(`text="a >> b" >> div`)).toEqual([`text="a >> b"`, "div"])
  })

  test("单引号/模板串/转义引号同样感知", () => {
    expect(splitSelectorTokens(`text=' >> ' >> x`)).toEqual([`text=' >> '`, "x"])
    expect(splitSelectorTokens("text=` >> ` >> x")).toEqual(["text=` >> `", "x"])
    expect(splitSelectorTokens(`text="\\" >> " >> x`)).toEqual([`text="\\" >> "`, "x"])
  })

  test("无分隔符时返回单段", () => {
    expect(splitSelectorTokens("  button  ")).toEqual(["button"])
  })
})

describe("frameSegments(dle)", () => {
  test("internal:control=enter-frame 切出帧链", () => {
    expect(frameSegments("iframe >> internal:control=enter-frame >> button"))
      .toEqual(["iframe", "button"])
  })

  test("多层帧链按序归组", () => {
    expect(frameSegments("a >> internal:control=enter-frame >> b >> internal:control=enter-frame >> c"))
      .toEqual(["a", "b", "c"])
  })

  test("缺失帧 selector/子 selector 抛错", () => {
    expect(() => frameSegments("internal:control=enter-frame >> button"))
      .toThrow("frame locator is missing a frame selector")
    expect(() => frameSegments("iframe >> internal:control=enter-frame"))
      .toThrow("frame locator is missing a child selector")
  })
})

describe("modifierNames(CH) 与 pressParts(lle)", () => {
  test("ControlOrMeta 按平台映射(darwin=Meta,其余=Control)", () => {
    expect(modifierNames(["ControlOrMeta", "Shift"])).toEqual([
      process.platform === "darwin" ? "Meta" : "Control",
      "Shift",
    ])
  })

  test("pressParts 拆末键与修饰键并合并动作级 modifiers", () => {
    const parts = pressParts("Control+a", ["Shift"])
    expect(parts.key).toBe("a")
    expect(parts.modifiers).toEqual(modifierNames(["Shift", "Control"]))
  })

  test("无按键抛错;未知段被过滤", () => {
    expect(() => pressParts("", [])).toThrow("locator.press requires a key")
    const parts = pressParts("Enter", [])
    expect(parts.key).toBe("Enter")
    expect(parts.modifiers).toEqual([])
  })
})

describe("isRecoverableLocatorRace(ale)", () => {
  test("命中四类文档竞态消息", () => {
    expect(isRecoverableLocatorRace(new Error("Execution context was destroyed."))).toBe(true)
    expect(isRecoverableLocatorRace(new Error("Cannot find context with specified id"))).toBe(true)
    expect(isRecoverableLocatorRace(new Error("Frame was detached."))).toBe(true)
    expect(isRecoverableLocatorRace(new Error("Inspected target navigated"))).toBe(true)
  })

  test("其余错误与非 Error 返回 false", () => {
    expect(isRecoverableLocatorRace(new Error("timeout"))).toBe(false)
    expect(isRecoverableLocatorRace("Execution context was destroyed")).toBe(false)
  })
})
