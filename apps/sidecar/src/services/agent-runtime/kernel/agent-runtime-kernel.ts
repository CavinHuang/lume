import { randomUUID } from "node:crypto";

export interface AgentRuntimeKernelDispatch<TInput extends { threadId: string; userMessage: string }, TEmit> {
  input: TInput;
  emit: TEmit;
  abortSignal?: AbortSignal;
  onExecutionStarted?: () => void;
  priority?: "user" | "background";
  /** 由 execute 实现消费的透传开关（如 appendUserMessage），随队列项一并保留。 */
  executeHints?: { appendUserMessage?: boolean };
}

export interface AgentRuntimeKernelQueuedDispatch<TInput extends { threadId: string; userMessage: string }, TEmit>
  extends AgentRuntimeKernelDispatch<TInput, TEmit> {
  id: string;
  threadId: string;
  text: string;
  createdAt: number;
  revision: number;
  status: "queued" | "validating" | "blocked";
  blockedReason?: string;
}

export interface AgentRuntimeKernelQueuedMessage {
  id: string;
  threadId: string;
  text: string;
  createdAt: number;
  revision: number;
  status: "queued" | "validating" | "blocked";
}

export interface AgentRuntimeKernelDispatchResult {
  ok: true;
  mode: "sent" | "queued";
  queuedCount: number;
  queuedMessage?: AgentRuntimeKernelQueuedMessage;
}

export interface AgentRuntimeKernelOptions<TInput extends { threadId: string; userMessage: string }, TEmit> {
  execute: (dispatch: AgentRuntimeKernelDispatch<TInput, TEmit>) => Promise<void>;
  onDispatchError: (dispatch: AgentRuntimeKernelDispatch<TInput, TEmit>, error: unknown) => void;
  onQueuedCountChange?: (threadId: string, queuedCount: number) => void;
  validateQueued?: (dispatch: AgentRuntimeKernelQueuedDispatch<TInput, TEmit>) => Promise<void>;
  onQueuedBlocked?: (dispatch: AgentRuntimeKernelQueuedDispatch<TInput, TEmit>, error: unknown) => void;
  createQueuedDispatchId?: () => string;
  now?: () => number;
  /**
   * kernel 之外的线程占用面（如直调执行器的互斥包装）。占用期间新派发入队、
   * 队列不启动，直到占用方调用 notifyThreadReleased（#398）。
   */
  isThreadOccupied?: (threadId: string) => boolean;
}

export class AgentRuntimeKernel<TInput extends { threadId: string; userMessage: string }, TEmit> {
  private readonly activeThreads = new Set<string>();
  private readonly paused = new Set<string>();
  private readonly activeAbortControllers = new Map<string, AbortController>();
  private readonly queuedDispatches = new Map<string, Array<AgentRuntimeKernelQueuedDispatch<TInput, TEmit>>>();
  private readonly queueRevisions = new Map<string, number>();
  private readonly running = new Set<Promise<void>>();

  constructor(private readonly options: AgentRuntimeKernelOptions<TInput, TEmit>) {}

  dispatch(
    input: TInput,
    emit: TEmit,
    options?: { onExecutionStarted?: () => void; priority?: "user" | "background"; executeHints?: { appendUserMessage?: boolean } }
  ): AgentRuntimeKernelDispatchResult {
    const dispatch = {
      input,
      emit,
      onExecutionStarted: options?.onExecutionStarted,
      priority: options?.priority ?? "user",
      ...(options?.executeHints ? { executeHints: options.executeHints } : {})
    };
    if (
      this.activeThreads.has(input.threadId)
      || this.options.isThreadOccupied?.(input.threadId)
      || this.getQueuedCount(input.threadId) > 0
    ) {
      const queue = this.queuedDispatches.get(input.threadId) ?? [];
      const queuedDispatch = this.createQueuedDispatch(dispatch);
      queue.push(queuedDispatch);
      this.queuedDispatches.set(input.threadId, queue);
      this.touchQueue(input.threadId);
      this.syncQueuedCount(input.threadId);
      if (!this.activeThreads.has(input.threadId)) this.scheduleStartNext(input.threadId);
      return {
        ok: true,
        mode: "queued",
        queuedCount: queue.length,
        queuedMessage: this.toQueuedMessage(queuedDispatch)
      };
    }

    this.startDispatch(dispatch);
    return {
      ok: true,
      mode: "sent",
      queuedCount: this.getQueuedCount(input.threadId)
    };
  }

  listQueued(threadId: string): Array<AgentRuntimeKernelQueuedDispatch<TInput, TEmit>> {
    return [...(this.queuedDispatches.get(threadId) ?? [])];
  }

  cancelActive(threadId: string): boolean {
    const controller = this.activeAbortControllers.get(threadId);
    if (!controller) return false;
    controller.abort(new Error("Agent run stopped"));
    return true;
  }

  /** 直接调用方（互斥包装）释放线程后调用，唤醒被占用挡住的队列。 */
  notifyThreadReleased(threadId: string): void {
    this.scheduleStartNext(threadId);
  }

  /** 等待线程完全空闲（无 kernel 活跃 run、无外部占用、无待执行排队任务）。用于需要同步语义的派发方。 */
  async waitForThreadIdle(threadId: string): Promise<void> {
    // #547:不得以全局 running 集合为空作退出条件——被 resume 占用挡住而入队
    // 的任务此刻不在 running 里,提前返回会让 automation 把未执行的 prompt 记成
    // success。改为短间隔轮询本线程的完整占用态(活跃/外部占用/待执行排队);
    // 占用释放经 notifyThreadReleased→scheduleStartNext 及时派发,轮询随即收敛。
    // blocked 项不会自愈(startNextQueued 跳过队首 blocked,仅人工 retry/remove
    // 可清除),计入等待会让 automation 无限挂死且心跳续租使陈旧租约兜底失效
    // ——排除之,该子场景退回"记 success 但 prompt 被挡"的旧诚实度(#547 review)。
    // 队列被 pause(STOP_THREAD)同理:只有手动 resume 能解除,不计入 busy。
    const hasRunnableQueue = (): boolean =>
      !this.isPaused(threadId)
      && this.listQueued(threadId).some((item) => item.status !== "blocked");
    while (
      this.activeThreads.has(threadId)
      || this.options.isThreadOccupied?.(threadId)
      || hasRunnableQueue()
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  getQueueRevision(threadId: string): number {
    return this.queueRevisions.get(threadId) ?? 0;
  }

  reorderQueued(threadId: string, orderedIds: string[], expectedRevision = this.getQueueRevision(threadId)): Array<AgentRuntimeKernelQueuedDispatch<TInput, TEmit>> {
    this.assertExpectedRevision(threadId, expectedRevision);
    const queue = this.queuedDispatches.get(threadId) ?? [];
    if (queue.length === 0) {
      return [];
    }
    const byId = new Map(queue.map((item) => [item.id, item]));
    const ordered = orderedIds
      .map((id) => byId.get(id))
      .filter((item): item is AgentRuntimeKernelQueuedDispatch<TInput, TEmit> => Boolean(item));
    const orderedIdSet = new Set(ordered.map((item) => item.id));
    const remaining = queue.filter((item) => !orderedIdSet.has(item.id));
    const nextQueue = [...ordered, ...remaining];
    this.queuedDispatches.set(threadId, nextQueue);
    this.touchQueue(threadId);
    this.syncQueuedCount(threadId);
    if (!this.activeThreads.has(threadId)) this.scheduleStartNext(threadId);
    return [...nextQueue];
  }

  removeQueued(threadId: string, queuedDispatchId: string, expectedRevision = this.getQueueRevision(threadId)): AgentRuntimeKernelQueuedDispatch<TInput, TEmit> | null {
    this.assertExpectedRevision(threadId, expectedRevision);
    const queue = this.queuedDispatches.get(threadId) ?? [];
    const index = queue.findIndex((item) => item.id === queuedDispatchId);
    if (index < 0) {
      return null;
    }
    const nextQueue = [...queue.slice(0, index), ...queue.slice(index + 1)];
    if (nextQueue.length === 0) {
      this.queuedDispatches.delete(threadId);
    } else {
      this.queuedDispatches.set(threadId, nextQueue);
    }
    this.touchQueue(threadId);
    this.syncQueuedCount(threadId);
    return queue[index] ?? null;
  }

  prependQueuedDispatches(threadId: string, dispatches: Array<AgentRuntimeKernelQueuedDispatch<TInput, TEmit>>): void {
    if (dispatches.length === 0) {
      return;
    }
    const queue = this.queuedDispatches.get(threadId) ?? [];
    this.queuedDispatches.set(threadId, [...dispatches, ...queue]);
    this.touchQueue(threadId);
    this.syncQueuedCount(threadId);
    if (!this.activeThreads.has(threadId)) this.scheduleStartNext(threadId);
  }

  updateQueued(
    threadId: string,
    queuedDispatchId: string,
    expectedRevision: number,
    update: Pick<TInput, "userMessage"> & Partial<TInput>
  ): AgentRuntimeKernelQueuedDispatch<TInput, TEmit> | null {
    this.assertExpectedRevision(threadId, expectedRevision);
    const queue = this.queuedDispatches.get(threadId) ?? [];
    const item = queue.find((candidate) => candidate.id === queuedDispatchId);
    if (!item || (item.status !== "queued" && item.status !== "blocked")) return null;
    item.input = { ...item.input, ...update };
    item.text = update.userMessage;
    item.status = "queued";
    delete item.blockedReason;
    this.touchQueue(threadId);
    this.syncQueuedCount(threadId);
    if (!this.activeThreads.has(threadId)) this.scheduleStartNext(threadId);
    return item;
  }

  retryQueued(
    threadId: string,
    queuedDispatchId: string,
    expectedRevision = this.getQueueRevision(threadId)
  ): AgentRuntimeKernelQueuedDispatch<TInput, TEmit> | null {
    this.assertExpectedRevision(threadId, expectedRevision);
    const queue = this.queuedDispatches.get(threadId) ?? [];
    const item = queue.find((candidate) => candidate.id === queuedDispatchId);
    // 仅对 status==='blocked' 的项生效:清空 blockedReason、状态回 queued、重新派发
    if (!item || item.status !== "blocked") return null;
    item.status = "queued";
    delete item.blockedReason;
    this.touchQueue(threadId);
    this.syncQueuedCount(threadId);
    if (!this.activeThreads.has(threadId)) this.scheduleStartNext(threadId);
    return item;
  }

  /** 暂停某线程的队列派发:startNextQueued 将跳过该线程,直到 resumeQueue。 */
  pauseQueue(threadId: string): void {
    this.paused.add(threadId);
  }

  /** 解除暂停并尝试派发队列首项。 */
  resumeQueue(threadId: string): void {
    if (!this.paused.delete(threadId)) return;
    if (!this.activeThreads.has(threadId)) this.scheduleStartNext(threadId);
  }

  isPaused(threadId: string): boolean {
    return this.paused.has(threadId);
  }

  async waitForIdleForTest(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.allSettled(Array.from(this.running));
    }
  }

  resetForTest(): void {
    for (const controller of this.activeAbortControllers.values()) {
      controller.abort(new Error("Agent runtime reset"));
    }
    this.activeThreads.clear();
    this.paused.clear();
    this.activeAbortControllers.clear();
    this.queuedDispatches.clear();
    this.queueRevisions.clear();
    this.running.clear();
  }

  private startDispatch(dispatch: AgentRuntimeKernelDispatch<TInput, TEmit>): void {
    const task = this.processDispatch(dispatch)
      .finally(() => {
        this.running.delete(task);
      });
    this.running.add(task);
  }

  private async processDispatch(dispatch: AgentRuntimeKernelDispatch<TInput, TEmit>): Promise<void> {
    const threadId = dispatch.input.threadId;
    const abortController = new AbortController();
    const activeDispatch = { ...dispatch, abortSignal: abortController.signal };
    this.activeThreads.add(threadId);
    this.activeAbortControllers.set(threadId, abortController);
    this.syncQueuedCount(threadId);
    try {
      activeDispatch.onExecutionStarted?.();
      await this.options.execute(activeDispatch);
    } catch (error) {
      if (!abortController.signal.aborted) {
        this.options.onDispatchError(activeDispatch, error);
      }
    } finally {
      if (this.activeAbortControllers.get(threadId) === abortController) {
        this.activeAbortControllers.delete(threadId);
      }
      this.activeThreads.delete(threadId);
      await this.startNextQueued(threadId);
    }
  }

  private getQueuedCount(threadId: string): number {
    return this.queuedDispatches.get(threadId)?.length ?? 0;
  }

  private syncQueuedCount(threadId: string): void {
    this.options.onQueuedCountChange?.(threadId, this.getQueuedCount(threadId));
  }

  private createQueuedDispatch(
    dispatch: AgentRuntimeKernelDispatch<TInput, TEmit>
  ): AgentRuntimeKernelQueuedDispatch<TInput, TEmit> {
    return {
      ...dispatch,
      priority: dispatch.priority ?? "user",
      id: this.options.createQueuedDispatchId?.() ?? randomUUID(),
      threadId: dispatch.input.threadId,
      text: dispatch.input.userMessage,
      createdAt: this.options.now?.() ?? Date.now(),
      revision: this.getQueueRevision(dispatch.input.threadId),
      status: "queued"
    };
  }

  private toQueuedMessage(
    dispatch: AgentRuntimeKernelQueuedDispatch<TInput, TEmit>
  ): AgentRuntimeKernelQueuedMessage {
    return {
      id: dispatch.id,
      threadId: dispatch.threadId,
      text: dispatch.text,
      createdAt: dispatch.createdAt,
      revision: dispatch.revision,
      status: dispatch.status,
      ...(dispatch.blockedReason ? { blockedReason: dispatch.blockedReason } : {})
    };
  }

  private async startNextQueued(threadId: string): Promise<void> {
    if (this.activeThreads.has(threadId)) return;
    if (this.paused.has(threadId)) return;
    if (this.options.isThreadOccupied?.(threadId)) return;
    const queue = this.queuedDispatches.get(threadId) ?? [];
    const first = queue[0];
    const next = first?.priority === "background"
      ? queue.find((item) => item.priority !== "background") ?? first
      : first;
    if (!next || next.status === "blocked" || next.status === "validating") return;
    next.status = "validating";
    this.touchQueue(threadId);
    this.syncQueuedCount(threadId);
    try {
      await this.options.validateQueued?.(next);
    } catch (error) {
      next.status = "blocked";
      next.blockedReason = error instanceof Error ? error.message : String(error);
      this.touchQueue(threadId);
      this.syncQueuedCount(threadId);
      this.options.onQueuedBlocked?.(next, error);
      return;
    }
    const latestQueue = this.queuedDispatches.get(threadId) ?? [];
    const nextIndex = latestQueue.findIndex((item) => item.id === next.id);
    if (nextIndex < 0) return;
    latestQueue.splice(nextIndex, 1);
    if (latestQueue.length === 0) this.queuedDispatches.delete(threadId);
    else this.queuedDispatches.set(threadId, latestQueue);
    next.status = "queued";
    delete next.blockedReason;
    this.touchQueue(threadId);
    this.syncQueuedCount(threadId);
    this.startDispatch(next);
  }

  private scheduleStartNext(threadId: string): void {
    const task = this.startNextQueued(threadId).finally(() => this.running.delete(task));
    this.running.add(task);
  }

  private touchQueue(threadId: string): number {
    const revision = this.getQueueRevision(threadId) + 1;
    this.queueRevisions.set(threadId, revision);
    for (const item of this.queuedDispatches.get(threadId) ?? []) item.revision = revision;
    return revision;
  }

  private assertExpectedRevision(threadId: string, expectedRevision: number): void {
    const currentRevision = this.getQueueRevision(threadId);
    if (expectedRevision !== currentRevision) {
      throw new AgentRuntimeKernelQueueConflictError(currentRevision);
    }
  }
}

export class AgentRuntimeKernelQueueConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super(`queue revision conflict: expected current revision ${currentRevision}`);
    this.name = "AgentRuntimeKernelQueueConflictError";
  }
}
