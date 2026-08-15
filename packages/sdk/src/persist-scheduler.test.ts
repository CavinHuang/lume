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
    await Promise.resolve()
    expect(writes).toEqual(["m3"])
    latest = "m4"
    scheduler.schedule()
    vi.advanceTimersByTime(200)
    await Promise.resolve()
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
    await scheduler.flush()
    expect(writes).toEqual(["m1"])
    vi.advanceTimersByTime(200)
    expect(writes).toEqual(["m1"])
    vi.useRealTimers()
  })

  test("serializes overlapping writes and waits for the full chain", async () => {
    vi.useFakeTimers()
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    let markSecondStarted!: () => void
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve })
    const calls: number[] = []
    let activeWrites = 0
    let maxActiveWrites = 0
    const scheduler = createPersistScheduler(200, async () => {
      const call = calls.length + 1
      calls.push(call)
      activeWrites += 1
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites)
      await new Promise<void>((resolve) => {
        if (call === 1) releaseFirst = resolve
        else {
          releaseSecond = resolve
          markSecondStarted()
        }
      })
      activeWrites -= 1
    })

    scheduler.schedule()
    vi.advanceTimersByTime(200)
    await Promise.resolve()
    scheduler.schedule()
    vi.advanceTimersByTime(200)
    await Promise.resolve()
    expect(calls).toEqual([1])

    releaseFirst()
    await secondStarted
    expect(calls).toEqual([1, 2])
    expect(maxActiveWrites).toBe(1)

    const cancelled = scheduler.cancel()
    let cancelSettled = false
    void cancelled.then(() => { cancelSettled = true })
    await Promise.resolve()
    expect(cancelSettled).toBe(false)
    releaseSecond()
    await cancelled
    expect(cancelSettled).toBe(true)
    vi.useRealTimers()
  })
})
