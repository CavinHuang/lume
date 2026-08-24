import { describe, expect, test } from "bun:test"

import {
  finalizeSubagentOutput,
  finalizeSubagentOutputFromState,
  summarizeSubagentAssistantEvent,
} from "./subagent-output.js"

describe("subagent-output", () => {
  test("summarizeSubagentAssistantEvent aggregates assistant text and tool usage", () => {
    const result = summarizeSubagentAssistantEvent([
      { type: "text", text: "first summary" },
      { type: "tool_use", name: "Read" },
      { type: "text", text: "final summary" },
    ])

    expect(result.textOutput).toBe("first summary\n\nfinal summary")
    expect(result.lastAssistantMessage).toBe("final summary")
    expect(result.toolCalls).toEqual(["Read"])
    expect(result.toolUseCount).toBe(1)
  })

  test("finalizeSubagentOutput returns text instead of placeholder when summary exists", () => {
    const result = finalizeSubagentOutput("delegated task finished", ["Read", "Glob"])

    expect(result.output).toContain("delegated task finished")
    expect(result.output).not.toContain("Subagent completed with no text output")
    expect(result.lastAssistantMessage).toBe("delegated task finished")
  })

  test("finalizeSubagentOutputFromState surfaces subagent execution errors", () => {
    const result = finalizeSubagentOutputFromState({
      textOutput: "",
      toolCalls: [],
      lastAssistantMessage: "",
      errorMessage: "OpenAI API error: 400 invalid model",
      status: "errored",
    })

    expect(result.output).toContain("Subagent error: OpenAI API error: 400 invalid model")
    expect(result.lastAssistantMessage).toBe("Subagent error: OpenAI API error: 400 invalid model")
  })

  test("finalizeSubagentOutputFromState keeps partial output when errored", () => {
    const result = finalizeSubagentOutputFromState({
      textOutput: "half-finished analysis with useful findings",
      toolCalls: ["Read"],
      lastAssistantMessage: "half-finished analysis with useful findings",
      errorMessage: "aborted by user",
      status: "aborted",
    })

    expect(result.output).toContain("half-finished analysis with useful findings")
    expect(result.output).toContain("[Subagent error: aborted by user]")
    expect(result.lastAssistantMessage).toBe("Subagent error: aborted by user")
  })

  test("finalizeSubagentOutputFromState truncates oversized partial output on the error path too", () => {
    const result = finalizeSubagentOutputFromState({
      textOutput: "w".repeat(45_000),
      toolCalls: [],
      lastAssistantMessage: "",
      errorMessage: "provider timeout",
      status: "errored",
    })

    expect(result.output).toContain("truncated")
    expect(result.output).toContain("[Subagent error: provider timeout]")
    expect(result.output.length).toBeLessThan(46_000)
  })

  test("finalizeSubagentOutput truncates oversized output keeping the tail", () => {
    const longText = `${"x".repeat(31_000)}\n\nfinal conclusion`
    const result = finalizeSubagentOutput(longText, [])

    expect(result.output.length).toBeLessThan(31_000)
    expect(result.output).toContain("final conclusion")
    expect(result.output).toContain("truncated")
  })

  test("finalizeSubagentOutput keeps exactly-at-limit output untruncated (off-by-one guard)", () => {
    const exactText = "y".repeat(30_000)
    const result = finalizeSubagentOutput(exactText, [])

    expect(result.output.startsWith(exactText)).toBe(true)
    expect(result.output).not.toContain("truncated")
  })

  test("finalizeSubagentOutput appends tool summary after truncation without losing it", () => {
    const longText = "z".repeat(40_000)
    const result = finalizeSubagentOutput(longText, ["Read", "Glob"])

    expect(result.output.endsWith("[Tools used: Read, Glob]")).toBe(true)
    expect(result.output).toContain("truncated")
  })
})
