export interface AgentRuntimeKernelDispatch<TInput extends { threadId: string }, TEmit> {
  input: TInput;
  emit: TEmit;
  onExecutionStarted?: () => void;
}

export interface AgentRuntimeKernelDispatchResult {
  ok: true;
  mode: "sent" | "queued";
  queuedCount: number;
}

export interface AgentRuntimeKernelOptions<TInput extends { threadId: string }, TEmit> {
  execute: (dispatch: AgentRuntimeKernelDispatch<TInput, TEmit>) => Promise<void>;
  onDispatchError: (dispatch: AgentRuntimeKernelDispatch<TInput, TEmit>, error: unknown) => void;
  onQueuedCountChange?: (threadId: string, queuedCount: number) => void;
}

export class AgentRuntimeKernel<TInput extends { threadId: string }, TEmit> {
  private readonly activeThreads = new Set<string>();
  private readonly queuedDispatches = new Map<string, Array<AgentRuntimeKernelDispatch<TInput, TEmit>>>();
  private readonly running = new Set<Promise<void>>();

  constructor(private readonly options: AgentRuntimeKernelOptions<TInput, TEmit>) {}

  dispatch(
    input: TInput,
    emit: TEmit,
    options?: { onExecutionStarted?: () => void }
  ): AgentRuntimeKernelDispatchResult {
    const dispatch = {
      input,
      emit,
      onExecutionStarted: options?.onExecutionStarted
    };
    if (this.activeThreads.has(input.threadId)) {
      const queue = this.queuedDispatches.get(input.threadId) ?? [];
      queue.push(dispatch);
      this.queuedDispatches.set(input.threadId, queue);
      this.syncQueuedCount(input.threadId);
      return {
        ok: true,
        mode: "queued",
        queuedCount: queue.length
      };
    }

    this.startDispatch(dispatch);
    return {
      ok: true,
      mode: "sent",
      queuedCount: this.getQueuedCount(input.threadId)
    };
  }

  async waitForIdleForTest(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.allSettled(Array.from(this.running));
    }
  }

  resetForTest(): void {
    this.activeThreads.clear();
    this.queuedDispatches.clear();
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
    this.activeThreads.add(threadId);
    this.syncQueuedCount(threadId);
    try {
      dispatch.onExecutionStarted?.();
      await this.options.execute(dispatch);
    } catch (error) {
      this.options.onDispatchError(dispatch, error);
    } finally {
      this.activeThreads.delete(threadId);
      const queue = this.queuedDispatches.get(threadId) ?? [];
      const next = queue.shift();
      if (queue.length === 0) {
        this.queuedDispatches.delete(threadId);
      } else {
        this.queuedDispatches.set(threadId, queue);
      }
      this.syncQueuedCount(threadId);
      if (next) {
        this.startDispatch(next);
      }
    }
  }

  private getQueuedCount(threadId: string): number {
    return this.queuedDispatches.get(threadId)?.length ?? 0;
  }

  private syncQueuedCount(threadId: string): void {
    this.options.onQueuedCountChange?.(threadId, this.getQueuedCount(threadId));
  }
}
