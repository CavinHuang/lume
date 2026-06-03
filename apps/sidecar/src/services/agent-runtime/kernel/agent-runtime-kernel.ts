import { randomUUID } from "node:crypto";

export interface AgentRuntimeKernelDispatch<TInput extends { threadId: string; userMessage: string }, TEmit> {
  input: TInput;
  emit: TEmit;
  onExecutionStarted?: () => void;
}

export interface AgentRuntimeKernelQueuedDispatch<TInput extends { threadId: string; userMessage: string }, TEmit>
  extends AgentRuntimeKernelDispatch<TInput, TEmit> {
  id: string;
  threadId: string;
  text: string;
  createdAt: number;
}

export interface AgentRuntimeKernelQueuedMessage {
  id: string;
  threadId: string;
  text: string;
  createdAt: number;
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
  createQueuedDispatchId?: () => string;
  now?: () => number;
}

export class AgentRuntimeKernel<TInput extends { threadId: string; userMessage: string }, TEmit> {
  private readonly activeThreads = new Set<string>();
  private readonly queuedDispatches = new Map<string, Array<AgentRuntimeKernelQueuedDispatch<TInput, TEmit>>>();
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
      const queuedDispatch = this.createQueuedDispatch(dispatch);
      queue.push(queuedDispatch);
      this.queuedDispatches.set(input.threadId, queue);
      this.syncQueuedCount(input.threadId);
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

  reorderQueued(threadId: string, orderedIds: string[]): Array<AgentRuntimeKernelQueuedDispatch<TInput, TEmit>> {
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
    this.syncQueuedCount(threadId);
    return [...nextQueue];
  }

  removeQueued(threadId: string, queuedDispatchId: string): AgentRuntimeKernelQueuedDispatch<TInput, TEmit> | null {
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
    this.syncQueuedCount(threadId);
    return queue[index] ?? null;
  }

  prependQueuedDispatches(threadId: string, dispatches: Array<AgentRuntimeKernelQueuedDispatch<TInput, TEmit>>): void {
    if (dispatches.length === 0) {
      return;
    }
    const queue = this.queuedDispatches.get(threadId) ?? [];
    this.queuedDispatches.set(threadId, [...dispatches, ...queue]);
    this.syncQueuedCount(threadId);
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

  private createQueuedDispatch(
    dispatch: AgentRuntimeKernelDispatch<TInput, TEmit>
  ): AgentRuntimeKernelQueuedDispatch<TInput, TEmit> {
    return {
      ...dispatch,
      id: this.options.createQueuedDispatchId?.() ?? randomUUID(),
      threadId: dispatch.input.threadId,
      text: dispatch.input.userMessage,
      createdAt: this.options.now?.() ?? Date.now()
    };
  }

  private toQueuedMessage(
    dispatch: AgentRuntimeKernelQueuedDispatch<TInput, TEmit>
  ): AgentRuntimeKernelQueuedMessage {
    return {
      id: dispatch.id,
      threadId: dispatch.threadId,
      text: dispatch.text,
      createdAt: dispatch.createdAt
    };
  }
}
