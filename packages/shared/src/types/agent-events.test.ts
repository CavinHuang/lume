import { describe, expect, test } from "bun:test"
import { AGENT_IPC_CHANNELS } from "./agent.js"

describe("agent event bus channels", () => {
  test("exposes EVENTS push channel and GET_EVENTS request channel", () => {
    expect(AGENT_IPC_CHANNELS.EVENTS).toBe("agent:events")
    expect(AGENT_IPC_CHANNELS.GET_EVENTS).toBe("agent:get-events")
  })
})
