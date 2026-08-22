// apps/sidecar/src/services/agent-runtime/events/thread-event-bus.test.ts
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SdkEventEnvelope, SdkEventKind, SdkEventPhase, SdkLifecycleEvent } from "@lume/shared"
import { getThreadEventBus, releaseThreadEventBus, ThreadEventBus } from "./thread-event-bus.js"

let dir: string
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined as any })

const skeletonEvent = (kind: SdkEventKind, phase: SdkEventPhase, detail: unknown = { type: kind + "." + phase }): SdkLifecycleEvent => ({
  runId: "r1", turnId: "t1", ts: 1, kind, phase, detail,
})

describe("ThreadEventBus", () => {
  test("assigns monotonic seq per thread and reads pending updates from buffer", async () => {
    dir = mkdtempSync(join(tmpdir(), "bus-"))
    const bus = getThreadEventBus(dir)
    const s1 = await bus.publish("th1", "r1", skeletonEvent("message", "update"))
    const s2 = await bus.publish("th1", "r1", skeletonEvent("message", "update"))
    const other = await bus.publish("th2", "r1", skeletonEvent("run", "start"))
    expect(s2).toBe(s1 + 1)
    expect(other).toBe(1) // per-thread seq

    // 持久折叠(#257):同 key update 只保留最新一条,read 从缓冲归并可见
    const all = await bus.read("th1")
    expect(all.map((e) => e.seq)).toEqual([s2])
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

  test("coalesces same kind+phase updates within 16ms window (push and persist)", async () => {
    dir = mkdtempSync(join(tmpdir(), "bus-"))
    const bus = getThreadEventBus(dir)
    const received: SdkEventEnvelope[] = []
    bus.subscribe("th1", (e) => received.push(e))
    await bus.publish("th1", "r1", skeletonEvent("message", "update", { type: "message.update", delta: null, partial: { text: "a", toolUses: [] } }))
    await bus.publish("th1", "r1", skeletonEvent("message", "update", { type: "message.update", delta: null, partial: { text: "ab", toolUses: [] } }))
    await new Promise((r) => setTimeout(r, 40))
    // 推送只收到最后一条(UI 折叠),窗口到期后磁盘也只有最新累计态(持久折叠)
    expect(received).toHaveLength(1)
    expect((received[0]?.detail as { partial: { text: string } }).partial.text).toBe("ab")
    const persisted = await bus.read("th1")
    expect(persisted.length).toBe(1)
    expect((persisted[0]?.detail as { partial: { text: string } }).partial.text).toBe("ab")
  })

  test("non-update phase flushes pending updates to disk in order (run tail not lost)", async () => {
    dir = mkdtempSync(join(tmpdir(), "bus-"))
    const bus = getThreadEventBus(dir)
    const seq1 = await bus.publish("th1", "r1", skeletonEvent("message", "update", { type: "message.update", delta: null, partial: { text: "a", toolUses: [] } }))
    const seq2 = await bus.publish("th1", "r1", skeletonEvent("message", "update", { type: "message.update", delta: null, partial: { text: "ab", toolUses: [] } }))
    await bus.publish("th1", "r1", skeletonEvent("message", "end", { type: "message.end", message: { role: "assistant", content: [] } }))
    // end 相位先把挂起 update 冲盘再写自身:磁盘 seq 有洞(1 被折叠)但单调,update 早于 end
    const all = await bus.read("th1")
    expect(all.map((e) => e.seq)).toEqual([seq2, seq2 + 1])
    expect(all[0]?.phase).toBe("update")
    expect(all[1]?.phase).toBe("end")
    expect(seq2).toBe(seq1 + 1)
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

  test("hasEvents 与 readFile 截断语义严格一致（F4 分叉判空捷径）", async () => {
    dir = mkdtempSync(join(tmpdir(), "bus-"))
    const bus = new ThreadEventBus(dir)
    expect(bus.hasEvents("th1")).toBe(false) // 文件缺失

    await bus.publish("th1", "r1", skeletonEvent("run", "start"))
    expect(bus.hasEvents("th1")).toBe(true)

    // 首行即毒行：size>0 但 readFile 截断为空——hasEvents 必须同样判空，
    // 否则 F4 分叉误判走总线单读，历史两侧（旧投影被裁 + read 也空）都读不到
    const poisoned = join(dir, "th2.events.jsonl")
    await Bun.write(poisoned, "not-json\n")
    expect(bus.hasEvents("th2")).toBe(false)

    // 全空行同 false
    const blank = join(dir, "th3.events.jsonl")
    await Bun.write(blank, "\n\n")
    expect(bus.hasEvents("th3")).toBe(false)
  })

  test("releaseThread flushes pending updates before dropping thread state", async () => {
    dir = mkdtempSync(join(tmpdir(), "bus-release-flush-"))
    const bus = getThreadEventBus(dir)
    const seq = await bus.publish("th1", "r1", skeletonEvent("message", "update"))
    releaseThreadEventBus(dir, "th1")
    // 释放即冲盘:重建实例(不靠窗口)能读到挂起的 update
    const rebuilt = getThreadEventBus(dir)
    const all = await rebuilt.read("th1")
    expect(all.map((e) => e.seq)).toEqual([seq])
    const next = await rebuilt.publish("th1", "r1", skeletonEvent("run", "end"))
    expect(next).toBe(seq + 1)
  })

  test("hasEvents counts pending persist buffer when file is empty", async () => {
    dir = mkdtempSync(join(tmpdir(), "bus-has-"))
    const bus = new ThreadEventBus(dir)
    // 首条事件是 update(极端:投影链未发 run.start)且尚未过窗口——文件空但缓冲有事件
    await bus.publish("th1", "r1", skeletonEvent("message", "update"))
    expect(bus.hasEvents("th1")).toBe(true)
  })

  test("releaseThreadEventBus 释放线程 state 与实例，重建后 nextSeq 从文件续读", async () => {
    dir = mkdtempSync(join(tmpdir(), "bus-release-"))
    const bus = getThreadEventBus(dir)
    const seq1 = await bus.publish("th1", "r1", skeletonEvent("run", "start"))

    let delivered = 0
    bus.subscribe("th1", () => { delivered += 1 })
    releaseThreadEventBus(dir, "th1")

    // 释放后同 bus 实例再 publish（模拟未预期复用）不再触达旧 listener
    await bus.publish("th1", "r1", skeletonEvent("message", "end"))
    expect(delivered).toBe(0)

    // 重建实例：seq 从落盘文件续读（两条事件都在），不重置
    const rebuilt = getThreadEventBus(dir)
    const all = await rebuilt.read("th1")
    expect(all.map((e) => e.seq)).toEqual([seq1, seq1 + 1])
    const seq3 = await rebuilt.publish("th1", "r1", skeletonEvent("run", "end"))
    expect(seq3).toBe(seq1 + 2)
  })
})
