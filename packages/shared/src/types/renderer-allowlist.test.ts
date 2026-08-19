import { describe, expect, test } from "bun:test"
import { AGENT_IPC_CHANNELS } from "./agent.js"
import { BROWSER_IPC_CHANNELS } from "./browser-runtime.js"
import { LUME_CONFIG_IPC_CHANNELS } from "./lume-config.js"
import { PLANNING_TODO_IPC_CHANNELS } from "./planning-todo.js"
import { PLUGIN_PACKAGE_PRIVILEGED_IPC_CHANNELS } from "./agent.js"
import { SHARED_RENDERER_SIDECAR_METHODS } from "./renderer-allowlist.js"
import { normalizeBackgroundTaskStatus } from "./runtime-event.js"

describe("SHARED_RENDERER_SIDECAR_METHODS derivation", () => {
  test("包含公共 agent 通道", () => {
    expect(SHARED_RENDERER_SIDECAR_METHODS.has(AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE)).toBe(true)
    expect(SHARED_RENDERER_SIDECAR_METHODS.has(AGENT_IPC_CHANNELS.GET_EVENTS)).toBe(true)
  })

  test("排除通知类 key / privileged / browser 通道", () => {
    expect(SHARED_RENDERER_SIDECAR_METHODS.has(AGENT_IPC_CHANNELS.EVENTS)).toBe(false)
    expect(SHARED_RENDERER_SIDECAR_METHODS.has(LUME_CONFIG_IPC_CHANNELS.CHANGED)).toBe(false)
    expect(SHARED_RENDERER_SIDECAR_METHODS.has(PLANNING_TODO_IPC_CHANNELS.REMINDER_DUE)).toBe(false)
    for (const channel of Object.values(PLUGIN_PACKAGE_PRIVILEGED_IPC_CHANNELS)) {
      expect(SHARED_RENDERER_SIDECAR_METHODS.has(channel)).toBe(false)
    }
    for (const channel of Object.values(BROWSER_IPC_CHANNELS)) {
      expect(SHARED_RENDERER_SIDECAR_METHODS.has(channel)).toBe(false)
    }
  })
})

describe("normalizeBackgroundTaskStatus", () => {
  test("四态映射与别名归一", () => {
    expect(normalizeBackgroundTaskStatus("completed")).toBe("completed")
    expect(normalizeBackgroundTaskStatus("failed")).toBe("failed")
    expect(normalizeBackgroundTaskStatus("stopped")).toBe("stopped")
    expect(normalizeBackgroundTaskStatus("killed")).toBe("stopped")
    expect(normalizeBackgroundTaskStatus("cancelled")).toBe("cancelled")
    expect(normalizeBackgroundTaskStatus("canceled")).toBe("cancelled")
  })

  test("attention/未知状态丢弃", () => {
    expect(normalizeBackgroundTaskStatus("running")).toBeUndefined()
    expect(normalizeBackgroundTaskStatus("attention")).toBeUndefined()
    expect(normalizeBackgroundTaskStatus("")).toBeUndefined()
  })
})
