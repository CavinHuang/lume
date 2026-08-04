import type { AgentPendingGuidance } from "@lume/shared";

interface RestorableQueuedDispatch {
  id: string;
  threadId: string;
  text: string;
  createdAt: number;
  attachmentsBrief?: string;
}

interface RunGuidanceRecord {
  guidance: AgentPendingGuidance;
  dispatch: unknown;
}

export interface ConsumedRunGuidance {
  guidanceIds: string[];
  text: string;
  items: AgentPendingGuidance[];
  attachmentsBrief?: string;
}

export interface RunGuidanceStoreOptions {
  now?: () => number;
}

export class RunGuidanceStore {
  private readonly pendingByThread = new Map<string, RunGuidanceRecord[]>();

  constructor(private readonly options: RunGuidanceStoreOptions = {}) {}

  addQueuedDispatch<TDispatch extends RestorableQueuedDispatch>(dispatch: TDispatch): AgentPendingGuidance {
    const guidance: AgentPendingGuidance = {
      id: dispatch.id,
      threadId: dispatch.threadId,
      text: dispatch.text,
      createdAt: dispatch.createdAt,
      promotedAt: this.options.now?.() ?? Date.now(),
      ...(dispatch.attachmentsBrief ? { attachmentsBrief: dispatch.attachmentsBrief } : {})
    };
    const pending = this.pendingByThread.get(dispatch.threadId) ?? [];
    pending.push({ guidance, dispatch });
    this.pendingByThread.set(dispatch.threadId, pending);
    return guidance;
  }

  listPending(threadId: string): AgentPendingGuidance[] {
    return (this.pendingByThread.get(threadId) ?? []).map((record) => record.guidance);
  }

  consumePendingGuidance(threadId: string): ConsumedRunGuidance | null {
    const pending = this.pendingByThread.get(threadId) ?? [];
    if (pending.length === 0) {
      return null;
    }
    this.pendingByThread.delete(threadId);
    const items = pending.map((record) => record.guidance);
    const briefs = items
      .map((item) => item.attachmentsBrief)
      .filter((value): value is string => Boolean(value));
    return {
      guidanceIds: items.map((item) => item.id),
      text: items.map((item, index) => `${index + 1}. ${item.text}`).join("\n"),
      items,
      ...(briefs.length > 0 ? { attachmentsBrief: briefs.join("\n") } : {})
    };
  }

  drainUnconsumedDispatches<TDispatch>(threadId: string): TDispatch[] {
    const pending = this.pendingByThread.get(threadId) ?? [];
    if (pending.length === 0) {
      return [];
    }
    this.pendingByThread.delete(threadId);
    return pending.map((record) => record.dispatch as TDispatch);
  }

  resetForTest(): void {
    this.pendingByThread.clear();
  }
}

export const runGuidanceStore = new RunGuidanceStore();
