import { describe, expect, test, vi } from "bun:test"
import { createPersistScheduler } from "./persist-scheduler"

describe("message-level throttled persistence", () => {
  test("schedules a trailing write once per window, merged to latest state", async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    let latest = ""
    const scheduler = createPersistScheduler(200, async () => {
      writes.push(latest)
    })
    latest = "m1"
    scheduler.schedule()
    vi.advanceTimersByTime(50)
    latest = "m2"
    scheduler.schedule()
    latest = "m3"
    scheduler.schedule()
    vi.advanceTimersByTime(200)
    expect(writes).toEqual(["m3"])
    latest = "m4"
    scheduler.schedule()
    vi.advanceTimersByTime(200)
    expect(writes).toEqual(["m3", "m4"])
    vi.useRealTimers()
  })

  test("flush() forces the pending write immediately without double-writing", async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    let latest = ""
    const scheduler = createPersistScheduler(200, async () => {
      writes.push(latest)
    })
    latest = "m1"
    scheduler.schedule()
    scheduler.flush()
    expect(writes).toEqual(["m1"])
    vi.advanceTimersByTime(200)
    expect(writes).toEqual(["m1"])
    vi.useRealTimers()
  })
})
