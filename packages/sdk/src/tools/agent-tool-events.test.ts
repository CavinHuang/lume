import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "../types.js"
import { annotateSubagentStreamingEvent } from "./agent-tool-events.js"

describe("annotateSubagentStreamingEvent", () => {
  test("应携带父级 Agent tool_use_id，用于显式绑定 subagent run", () => {
    const message = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{
          type: "text",
          text: "child output"
        }]
      }
    } as SDKMessage

    const tagged = annotateSubagentStreamingEvent(message, {
      subagentRunId: "run-1",
      parentSessionId: "parent-thread",
      parentToolUseId: "agent-tool-1"
    } as never)

    expect(tagged?.subagent_run_id).toBe("run-1")
    expect((tagged as SDKMessage | undefined)?.parent_tool_use_id).toBe("agent-tool-1")
  })
})
