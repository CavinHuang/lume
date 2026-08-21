import { describe, expect, test } from "bun:test"
import { BrowserActionQueue } from "./browser-action-queue"

describe("BrowserActionQueue", () => {
  test("serializes mutations that share a Browser session", async () => {
    const queue = new BrowserActionQueue()
    const order: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })

    const first = queue.run("session-1", async () => {
      order.push("first:start")
      await firstGate
      order.push("first:end")
      return 1
    })
    const second = queue.run("session-1", async () => {
      order.push("second")
      return 2
    })

    await Promise.resolve()
    expect(order).toEqual(["first:start"])
    releaseFirst()
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2])
    expect(order).toEqual(["first:start", "first:end", "second"])
  })

  test("continues the queue after an action fails", async () => {
    const queue = new BrowserActionQueue()
    const first = queue.run("session-1", async () => { throw new Error("failed") })
    const second = queue.run("session-1", async () => "recovered")

    await expect(first).rejects.toThrow("failed")
    await expect(second).resolves.toBe("recovered")
  })

  test("cancels queued actions without replaying them after user takeover", async () => {
    const queue = new BrowserActionQueue()
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const first = queue.run("session-1", () => firstGate)
    const second = queue.run("session-1", async () => "must-not-run")

    await Promise.resolve()
    queue.cancel("session-1")
    const cancelled = second.then(() => undefined, (error: Error) => error)
    releaseFirst()

    await expect(first).resolves.toBeUndefined()
    expect((await cancelled)?.message).toBe("user_takeover_required")
  })
})
