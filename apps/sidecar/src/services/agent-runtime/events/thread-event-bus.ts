/**
 * ThreadEventBus —— 线程级事件总线:seq 单写者分配 + append-only jsonl 持久化 + 16ms 微批推送。
 * 原则:持久化即承诺(publish 在 appendFileSync 完成后 resolve),推送只是加速(read 永远可回放)。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { SdkEventEnvelope, SdkLifecycleEvent } from "@lume/shared"

/** update 相位微批窗口(ms):同 kind:phase:turnId 的折叠窗口 */
const UPDATE_COALESCE_MS = 16

interface ThreadState {
  /** 下一个待分配的 seq(初始化 = 文件最后一条合法行 seq + 1) */
  nextSeq: number
  listeners: Set<(e: SdkEventEnvelope) => void>
  /** 微批缓冲:key=`kind:phase:turnId`,value=最新 envelope;同 key 替换即"折叠后 partial" */
  coalesceBuffer: Map<string, SdkEventEnvelope>
  coalesceTimer: ReturnType<typeof setTimeout> | null
}

export class ThreadEventBus {
  private readonly sessionDir: string
  private readonly threads = new Map<string, ThreadState>()

  constructor(sessionDir: string) {
    this.sessionDir = sessionDir
    mkdirSync(sessionDir, { recursive: true })
  }

  /** 盖信封、append 落盘、入微批队列;返回分配的 seq(落盘成功后 resolve)。 */
  publish(threadId: string, runId: string, event: SdkLifecycleEvent): Promise<number> {
    const st = this.state(threadId)
    const seq = st.nextSeq++
    const envelope: SdkEventEnvelope = {
      v: 1,
      seq,
      threadId,
      runId,
      turnId: event.turnId,
      ts: event.ts,
      kind: event.kind,
      phase: event.phase,
      detail: event.detail,
    }
    // 同步 append:resolve 即代表已持久化
    appendFileSync(this.file(threadId), JSON.stringify(envelope) + "\n")

    if (event.phase === "update") {
      const key = `${event.kind}:${event.phase}:${event.turnId ?? ""}`
      st.coalesceBuffer.set(key, envelope)
      if (!st.coalesceTimer) {
        st.coalesceTimer = setTimeout(() => this.flush(st), UPDATE_COALESCE_MS)
      }
    } else {
      // 非 update 相位:先冲掉挂起的 update(保序——同 turn 的 message.end 必须晚于其 update),再立即推
      this.flush(st)
      this.dispatch(st, envelope)
    }
    return Promise.resolve(seq)
  }

  /** 订阅实时推送(微批后);返回退订函数。 */
  subscribe(threadId: string, listener: (e: SdkEventEnvelope) => void): () => void {
    const st = this.state(threadId)
    st.listeners.add(listener)
    return () => st.listeners.delete(listener)
  }

  /** 快照/续传:seq > afterSeq 的全部已持久化事件(afterSeq 缺省=全部=回放)。 */
  async read(threadId: string, afterSeq?: number): Promise<SdkEventEnvelope[]> {
    const all = this.readFile(threadId)
    return afterSeq === undefined ? all : all.filter((e) => e.seq > afterSeq)
  }

  private file(threadId: string): string {
    return join(this.sessionDir, `${threadId}.events.jsonl`)
  }

  private state(threadId: string): ThreadState {
    let st = this.threads.get(threadId)
    if (!st) {
      const envelopes = this.readFile(threadId)
      this.repairTornTail(threadId)
      st = {
        // 序号续上而非重写:以文件尾部最后一条合法行为基数(半行被截断,不参与计数)
        nextSeq: (envelopes[envelopes.length - 1]?.seq ?? 0) + 1,
        listeners: new Set(),
        coalesceBuffer: new Map(),
        coalesceTimer: null,
      }
      this.threads.set(threadId, st)
    }
    return st
  }

  /**
   * 半行尾修复(每线程每进程一次,首次触达时):若文件不以 \n 结尾(断电残行),
   * 截掉最后一个 \n 之后的内容。否则下一次 append 会把合法行拼进毒行,
   * read() 在毒行截断后该线程 seq≥2 的事件将永久不可读。
   */
  private repairTornTail(threadId: string): void {
    const file = this.file(threadId)
    if (!existsSync(file)) return
    const content = readFileSync(file, "utf8")
    if (content === "" || content.endsWith("\n")) return
    writeFileSync(file, content.slice(0, content.lastIndexOf("\n") + 1))
  }

  /** 逐行读取;遇非法 JSON 行(断电半行)即截断后续。 */
  private readFile(threadId: string): SdkEventEnvelope[] {
    const file = this.file(threadId)
    if (!existsSync(file)) return []
    const out: SdkEventEnvelope[] = []
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue
      try {
        out.push(JSON.parse(line) as SdkEventEnvelope)
      } catch {
        break
      }
    }
    return out
  }

  /** 冲微批:按插入序推给 listeners */
  private flush(st: ThreadState): void {
    if (st.coalesceTimer) {
      clearTimeout(st.coalesceTimer)
      st.coalesceTimer = null
    }
    if (st.coalesceBuffer.size === 0) return
    const envelopes = [...st.coalesceBuffer.values()]
    st.coalesceBuffer.clear()
    for (const envelope of envelopes) this.dispatch(st, envelope)
  }

  /** 推送给全部 listeners;单个 listener 抛异常不影响其余订阅者(推送失败不影响持久化) */
  private dispatch(st: ThreadState, envelope: SdkEventEnvelope): void {
    for (const listener of st.listeners) {
      try {
        listener(envelope)
      } catch {
        // 吞掉 listener 异常:不影响同批其他订阅者
      }
    }
  }
}

const instances = new Map<string, ThreadEventBus>()

/** 每 sessionDir 单例 */
export function getThreadEventBus(sessionDir: string): ThreadEventBus {
  let bus = instances.get(sessionDir)
  if (!bus) instances.set(sessionDir, (bus = new ThreadEventBus(sessionDir)))
  return bus
}
