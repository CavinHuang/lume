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

  test("finalizeSubagentOutput truncates oversized output keeping the tail", () => {
    const longText = `${"x".repeat(31_000)}\n\nfinal conclusion`
    const result = finalizeSubagentOutput(longText, [])

    expect(result.output.length).toBeLessThan(31_000)
    expect(result.output).toContain("final conclusion")
    expect(result.output).toContain("truncated")
  })
})
