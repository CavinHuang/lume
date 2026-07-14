import type { ToolResult } from "@lume/agent-sdk";

export interface ComputerUseSessionExecutionContext {
  [key: string]: unknown;
}

export interface ComputerUseSessionRequest {
  method: string;
  params: Record<string, unknown>;
  context: ComputerUseSessionExecutionContext;
}

export interface ComputerUseSessionResult {
  value: unknown;
  content?: ToolResult["content"];
  meta?: Record<string, unknown>;
}

export type ComputerUseSessionExecutor = (
  request: ComputerUseSessionRequest,
) => Promise<ComputerUseSessionResult>;

export class ComputerUseSession {
  private tail: Promise<void> = Promise.resolve();
  private requested = false;

  constructor(private readonly execute: ComputerUseSessionExecutor) {}

  request(request: ComputerUseSessionRequest): Promise<ComputerUseSessionResult> {
    this.requested = true;
    const result = this.tail.then(() => this.execute(request));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  isActive(): boolean {
    return this.requested;
  }
}

export class ComputerUseSessionRegistry {
  private readonly sessions = new Map<string, ComputerUseSession>();

  getOrCreate(input: {
    threadId: string;
    execute?: ComputerUseSessionExecutor;
    createExecutor?: () => ComputerUseSessionExecutor;
  }): ComputerUseSession {
    const existing = this.sessions.get(input.threadId);
    if (existing) return existing;
    const execute = input.execute ?? input.createExecutor?.();
    if (!execute) throw new Error("Computer Use session executor is required");
    const session = new ComputerUseSession(execute);
    this.sessions.set(input.threadId, session);
    return session;
  }

  clear(threadId: string): void {
    this.sessions.delete(threadId);
  }

  isActive(threadId: string): boolean {
    return this.sessions.get(threadId)?.isActive() === true;
  }
}

let globalRegistry: ComputerUseSessionRegistry | null = null;

export function getComputerUseSessionRegistry(): ComputerUseSessionRegistry {
  globalRegistry ??= new ComputerUseSessionRegistry();
  return globalRegistry;
}
