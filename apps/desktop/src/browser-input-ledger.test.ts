import { describe, expect, test } from "bun:test"
import { BrowserInputLedger } from "./browser-input-ledger"

describe("BrowserInputLedger", () => {
  test("matches only input events emitted by the expected CDP command", () => {
    const ledger = new BrowserInputLedger(() => 100)
    ledger.expectCommand("tab-1", "Input.dispatchMouseEvent", { type: "mousePressed", button: "left" })
    ledger.expectCommand("tab-1", "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter" })

    expect(ledger.consumeMouse("tab-1", { type: "mouseDown", button: "right" })).toBeFalse()
    expect(ledger.consumeMouse("tab-1", { type: "mouseDown", button: "left" })).toBeTrue()
    expect(ledger.consumeKey("tab-1", { type: "keyDown", key: "Escape" })).toBeFalse()
    expect(ledger.consumeKey("tab-1", { type: "keyDown", key: "Enter" })).toBeTrue()
  })

  test("expires and clears unmatched expectations", () => {
    let now = 100
    const ledger = new BrowserInputLedger(() => now)
    ledger.expectCommand("tab-1", "Input.dispatchMouseEvent", { type: "mouseWheel" })
    now = 601

    expect(ledger.consumeMouse("tab-1", { type: "mouseWheel" })).toBeFalse()
    ledger.expectCommand("tab-1", "Input.insertText", { text: "hello" })
    ledger.clear("tab-1")
    expect(ledger.consumeKey("tab-1", { type: "char", key: "h" })).toBeFalse()
  })
})
