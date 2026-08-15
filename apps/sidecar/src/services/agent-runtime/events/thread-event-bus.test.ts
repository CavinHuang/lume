// apps/sidecar/src/services/agent-runtime/events/thread-event-bus.test.ts
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SdkEventEnvelope, SdkEventKind, SdkEventPhase, SdkLifecycleEvent } from "@lume/shared"
import { getThreadEventBus, ThreadEventBus } from "./thread-event-bus.js"

let dir: string
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined as any })

const skeletonEvent = (kind: SdkEventKind, phase: SdkEventPhase, detail: unknown = { type: kind + "." + phase }): SdkLifecycleEvent => ({
  runId: "r1", turnId: "t1", ts: 1, kind, phase, detail,
})

describe("ThreadEventBus", () => {
  test("assigns monotonic seq per thread and persists append-only", async () => {
    dir = mkdtempSync(join(tmpdir(), "bus-"))
    const bus = getThreadEventBus(dir)
    const s1 = await bus.publish("th1", "r1", skeletonEvent("message", "update"))
    const s2 = await bus.publish("th1", "r1", skeletonEvent("message", "update"))
    const other = await bus.publish("th2", "r1", skeletonEvent("run", "start"))
    expect(s2).toBe(s1 + 1)
    expect(other).toBe(1) // per-thread seq

    const all = await bus.read("th1")
    expect(all.map((e) => e.seq)).toEqual([1, 2])
    const first = all[0]
    expect(first?.threadId).toBe("th1")
    expect(first?.v).toBe(1)
  })

  test("read(afterSeq) returns pure increment", async () => {
    dir = mkdtempSync(join(tmpdir(), "bus-"))
    const bus = getThreadEventBus(dir)
    await bus.publish("th1", "r1", skeletonEvent("run", "start"))
    await bus.publish("th1", "r1", skeletonEvent("message", "end"))
    const inc = await bus.read("th1", 1)
    expect(inc.map((e) => e.seq)).toEqual([2])
  })

  test("coalesces same kind+phase updates within 16ms window", async () => {
    dir = mkdtempSync(join(tmpdir(), "bus-"))
    const bus = getThreadEventBus(dir)
    const received: SdkEventEnvelope[] = []
    bus.subscribe("th1", (e) => received.push(e))
    await bus.publish("th1", "r1", skeletonEvent("message", "update", { type: "message.update", delta: null, partial: { text: "a", toolUses: [] } }))
    await bus.publish("th1", "r1", skeletonEvent("message", "update", { type: "message.update", delta: null, partial: { text: "ab", toolUses: [] } }))
    await new Promise((r) => setTimeout(r, 40))
    // 持久化 2 条(都落盘),推送只收到最后一条(折叠)
    expect(received).toHaveLength(1)
    expect((received[0]?.detail as { partial: { text: string } }).partial.text).toBe("ab")
    expect((await bus.read("th1")).length).toBe(2)
  })

  test("non-update phases are pushed immediately without coalescing", async () => {
    dir = mkdtempSync(join(tmpdir(), "bus-"))
    const bus = getThreadEventBus(dir)
    const received: SdkEventEnvelope[] = []
    bus.subscribe("th1", (e) => received.push(e))
    await bus.publish("th1", "r1", skeletonEvent("turn", "end"))
    await bus.publish("th1", "r1", skeletonEvent("run", "end"))
    expect(received.map((e) => e.phase)).toEqual(["end", "end"])
  })

  test("new instance on same dir resumes seq and reads torn tail safely", async () => {
    dir = mkdtempSync(join(tmpdir(), "bus-"))
    const bus = getThreadEventBus(dir)
    await bus.publish("th1", "r1", skeletonEvent("run", "start"))
    // 模拟半行尾(断电)
    const { appendFileSync } = await import("node:fs")
    appendFileSync(join(dir, "th1.events.jsonl"), '{"seq":2,"bro')
    const bus2 = getThreadEventBus(dir)  // 同目录新实例(进程重启)
    const events = await bus2.read("th1")
    expect(events.map((e) => e.seq)).toEqual([1])       // 半行被截断
    const s = await bus2.publish("th1", "r1", skeletonEvent("message", "end"))
    expect(s).toBe(2)                                     // 序号续上而非重写
  })

  test("direct construction repairs torn tail before appending (restart path)", async () => {
    dir = mkdtempSync(join(tmpdir(), "bus-"))
    const bus = new ThreadEventBus(dir)
    await bus.publish("th1", "r1", skeletonEvent("run", "start"))
    // 模拟半行尾(断电)后进程重启:绕过单例直接构造
    const { appendFileSync } = await import("node:fs")
    appendFileSync(join(dir, "th1.events.jsonl"), '{"seq":2,"bro')
    const bus2 = new ThreadEventBus(dir)
    const s = await bus2.publish("th1", "r1", skeletonEvent("message", "end"))
    expect(s).toBe(2)
    // 毒行已被截断修复,publish 的新行可读——否则 seq≥2 永久不可读
    const events = await bus2.read("th1")
    expect(events.map((e) => e.seq)).toEqual([1, 2])
  })

  test("coalesced update is flushed before subsequent end phase (ordering invariant)", async () => {
    dir = mkdtempSync(join(tmpdir(), "bus-"))
    const bus = getThreadEventBus(dir)
    const received: SdkEventEnvelope[] = []
    bus.subscribe("th1", (e) => received.push(e))
    await bus.publish("th1", "r1", skeletonEvent("message", "update", { type: "message.update", delta: null, partial: { text: "a", toolUses: [] } }))
    await bus.publish("th1", "r1", skeletonEvent("message", "end", { type: "message.end", message: { role: "assistant", content: [] } }))
    expect(received.map((e) => e.phase)).toEqual(["update", "end"])
  })
})
