import { describe, expect, test } from "bun:test"
import { normalizeBrowserAgentScriptResult, prepareBrowserAgentScript } from "./browser-agent-script"

describe("browser Agent script", () => {
  test("prepares a bounded async isolated-world function call", () => {
    const call = prepareBrowserAgentScript({ script: "return arg.value + document.title", arg: { value: "Lume: " }, timeout_ms: 1_500 })

    expect(call.expression).toContain("return arg.value + document.title")
    expect(call.expression).toContain('{"value":"Lume: "}')
    expect(call.expression).toContain("script_result_too_large")
    expect(call.timeout).toBe(1_500)
    expect(call.userGesture).toBeTrue()
  })

  test("rejects missing and oversized scripts", () => {
    expect(() => prepareBrowserAgentScript({ script: "" })).toThrow("invalid_browser_request")
    expect(() => prepareBrowserAgentScript({ script: "x".repeat(50_001) })).toThrow("invalid_browser_request")
  })

  test("returns JSON values without remote object handles", () => {
    expect(normalizeBrowserAgentScriptResult({ result: { value: { title: "Lume", count: 2 } } })).toEqual({
      status: "completed",
      value: { title: "Lume", count: 2 },
    })
  })

  test("normalizes script exceptions for the tool boundary", () => {
    expect(normalizeBrowserAgentScriptResult({
      result: {},
      exceptionDetails: {
        text: "Uncaught",
        lineNumber: 3,
        columnNumber: 7,
        exception: { description: "Error: failed\n    at <anonymous>:3:7" },
      },
    })).toEqual({
      status: "exception",
      exception: { message: "Error: failed\n    at <anonymous>:3:7", line: 3, column: 7 },
    })
  })
})
