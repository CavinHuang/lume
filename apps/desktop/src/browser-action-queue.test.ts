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

  // #610:epoch/cancel 作废机制已删——cancel 从无调用方,user_takeover_required
  // 因此 100% 不可产出;作废需求由 stale_target/generation 在动作执行前仲裁
})
