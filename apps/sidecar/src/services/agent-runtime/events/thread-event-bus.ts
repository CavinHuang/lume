/**
 * ThreadEventBus —— 线程级事件总线:seq 单写者分配 + append-only jsonl 持久化 + 16ms 微批推送。
 * 持久化承诺(#257):非 update 相位即时落盘(publish 在 appendFileSync 后 resolve);
 * update 相位(流式累计 partial)进入持久折叠缓冲——同 key 只保留最新一条,由
 * 后续非 update 相位、PERSIST_COALESCE_MS 窗口或 releaseThread 落盘。
 * 此前每个流式 delta 的累计全文都同步写盘,长会话 events 体积近二次增长(~74% 字节浪费)。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { SdkEventEnvelope, SdkLifecycleEvent } from "@lume/shared"

/** update 相位微批窗口(ms):同 kind:phase:turnId 的折叠窗口 */
const UPDATE_COALESCE_MS = 16

/** update 相位持久折叠窗口(ms):崩溃时最多丢该窗口内的流式过渡态(终值由非 update 相位兜底落盘) */
const PERSIST_COALESCE_MS = 500

interface ThreadState {
  /** 下一个待分配的 seq(初始化 = 文件最后一条合法行 seq + 1) */
  nextSeq: number
  listeners: Set<(e: SdkEventEnvelope) => void>
  /** 微批缓冲:key=`kind:phase:turnId`,value=最新 envelope;同 key 替换即"折叠后 partial" */
  coalesceBuffer: Map<string, SdkEventEnvelope>
  coalesceTimer: ReturnType<typeof setTimeout> | null
  /** 持久折叠缓冲:与 coalesceBuffer 同 key 语义,但负责落盘——折叠后磁盘每个 key 每窗口只有最新累计态 */
  persistBuffer: Map<string, SdkEventEnvelope>
  persistTimer: ReturnType<typeof setTimeout> | null
}

export class ThreadEventBus {
  private readonly sessionDir: string
  private readonly threads = new Map<string, ThreadState>()

  constructor(sessionDir: string) {
    this.sessionDir = sessionDir
    mkdirSync(sessionDir, { recursive: true })
  }

  /**
   * 盖信封、入持久队列、入微批队列;返回分配的 seq。
   * 约束(调用方依赖,勿静默破坏):非 update 相位必须"同步落盘后 resolve"——resolve 即
   * 持久化完成;update 相位 resolve 即已进入持久折叠缓冲(最多 PERSIST_COALESCE_MS 后落盘,
   * 且任何后续非 update 相位先冲盘,run 尾(run.end)不丢)。run-loop 的 tee 对 publish 是
   * fire-and-forget(.catch 兜底),靠 pump 排空保证事件全部落盘;若改为真异步 fs(如
   * fs.promises),resolve 将先于落盘,tee 的 await pump 不再等落盘——改前必须同步改造 tee。
   */
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

    if (event.phase === "update") {
      // 持久折叠:同 key 只留最新累计态,由窗口/后续非 update 落盘——磁盘不再存每个 delta 的累计全文
      const key = `${event.kind}:${event.phase}:${event.turnId ?? ""}`
      st.persistBuffer.set(key, envelope)
      if (!st.persistTimer) {
        st.persistTimer = setTimeout(() => this.flushPersist(threadId, st), PERSIST_COALESCE_MS)
      }
      st.coalesceBuffer.set(key, envelope)
      if (!st.coalesceTimer) {
        st.coalesceTimer = setTimeout(() => this.flush(st), UPDATE_COALESCE_MS)
      }
    } else {
      // 非 update 相位:先冲掉挂起的 update(保序——同 turn 的 message.end 必须晚于其 update),
      // 再同步 append 本事件——run 边界(run.end/turn.end)到达即全部落盘
      this.flushPersist(threadId, st)
      appendFileSync(this.file(threadId), JSON.stringify(envelope) + "\n")
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

  /** 快照/续传:seq > afterSeq 的全部事件(文件 + 未落盘的持久折叠缓冲,按 seq 归并)。 */
  async read(threadId: string, afterSeq?: number): Promise<SdkEventEnvelope[]> {
    const all = [...this.readFile(threadId), ...this.pendingEnvelopes(threadId)].sort((a, b) => a.seq - b.seq)
    return afterSeq === undefined ? all : all.filter((e) => e.seq > afterSeq)
  }

  /**
   * 判空捷径(F4 分叉用):与 readFile 的截断语义严格一致——逐行找到第一条非空行,
   * JSON.parse 成功即有事件、失败(毒行)即无;全空行/文件缺失为无。不做全量对象分配。
   */
  hasEvents(threadId: string): boolean {
    const file = this.file(threadId)
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line) continue
        try {
          JSON.parse(line)
          return true
        } catch {
          return false
        }
      }
    }
    // 文件空/缺失:持久折叠缓冲里有挂起事件同样算有(F4 分叉不能误判为旧线程)
    return this.pendingEnvelopes(threadId).length > 0
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
        persistBuffer: new Map(),
        persistTimer: null,
      }
      this.threads.set(threadId, st)
    }
    return st
  }

  /** 释放线程 state（清挂起 timer 前先冲盘持久缓冲）；落盘文件不动，重建时 seq 从文件续读。 */
  releaseThread(threadId: string): void {
    const st = this.threads.get(threadId)
    if (!st) return
    this.flushPersist(threadId, st)
    if (st.coalesceTimer) clearTimeout(st.coalesceTimer)
    this.threads.delete(threadId)
  }

  /** 是否已不持有任何线程 state（instances 卸载条件）。 */
  isEmpty(): boolean {
    return this.threads.size === 0
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

  /** 持久折叠缓冲的挂起事件(按 seq 升序;不触达 state,空线程返回空) */
  private pendingEnvelopes(threadId: string): SdkEventEnvelope[] {
    const st = this.threads.get(threadId)
    if (!st || st.persistBuffer.size === 0) return []
    return [...st.persistBuffer.values()].sort((a, b) => a.seq - b.seq)
  }

  /** 冲持久折叠缓冲:按插入序 append 落盘(Map 迭代=插入序;同 key 替换不改变原插入位) */
  private flushPersist(threadId: string, st: ThreadState): void {
    if (st.persistTimer) {
      clearTimeout(st.persistTimer)
      st.persistTimer = null
    }
    if (st.persistBuffer.size === 0) return
    const lines = [...st.persistBuffer.values()].map((envelope) => JSON.stringify(envelope) + "\n").join("")
    st.persistBuffer.clear()
    appendFileSync(this.file(threadId), lines)
  }
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

/**
 * 线程硬删除路径释放该线程的总线 state（清挂起的微批 timer 与 listeners）；
 * 该 bus 不再持有任何线程时从 instances 卸载（sessionDir 按 threadId 一一派生，无共享）。
 * 再次 getThreadEventBus 会重建，nextSeq 从落盘文件续读——不影响同 sessionDir 其他线程。
 */
export function releaseThreadEventBus(sessionDir: string, threadId: string): void {
  const bus = instances.get(sessionDir)
  if (!bus) return
  bus.releaseThread(threadId)
  if (bus.isEmpty()) instances.delete(sessionDir)
}
