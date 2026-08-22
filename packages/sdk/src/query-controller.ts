import type {
  ContentBlockParam,
  Query,
  SDKMessage,
  SDKUserMessage,
} from './types.js'

type QueryInput = string | ContentBlockParam[] | SDKUserMessage
type QueryControllerMethods = {
  interrupt: Query['interrupt']
  setPermissionMode: Query['setPermissionMode']
  setModel: Query['setModel']
  setMaxThinkingTokens: Query['setMaxThinkingTokens']
  setCwd: Query['setCwd']
  getInitializationResult: Query['getInitializationResult']
  getContextUsage: Query['getContextUsage']
  reloadPlugins: Query['reloadPlugins']
  rewindFiles: Query['rewindFiles']
  stopTask: Query['stopTask']
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return !!value && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === 'function'
}

class AsyncInputQueue implements AsyncIterable<QueryInput> {
  private items: QueryInput[] = []
  private waiters: Array<{
    resolve: (value: IteratorResult<QueryInput>) => void
    reject: (reason?: unknown) => void
  }> = []
  private closed = false
  private failure: { reason: unknown } | null = null

  push(item: QueryInput): void {
    if (this.closed) {
      throw new Error('Query input stream is closed')
    }

    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.resolve({ done: false, value: item })
      return
    }

    this.items.push(item)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      waiter?.resolve({ done: true, value: undefined as never })
    }
  }

  /** Fault the queue: pending and future reads reject with the given reason. */
  fail(reason: unknown): void {
    if (this.closed || this.failure) return
    this.failure = { reason }
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      waiter?.reject(reason)
    }
  }

  async next(): Promise<IteratorResult<QueryInput>> {
    const item = this.items.shift()
    if (item !== undefined) {
      return { done: false, value: item }
    }

    if (this.failure) {
      throw this.failure.reason
    }

    if (this.closed) {
      return { done: true, value: undefined as never }
    }

    return new Promise<IteratorResult<QueryInput>>((resolve, reject) => {
      this.waiters.push({ resolve, reject })
    })
  }

  [Symbol.asyncIterator](): AsyncIterator<QueryInput> {
    return {
      next: () => this.next(),
    }
  }
}

export class QueryController implements Query {
  private readonly queue = new AsyncInputQueue()
  private readonly stream: AsyncGenerator<SDKMessage>

  constructor(
    private readonly methods: QueryControllerMethods,
    runner: (inputs: AsyncIterable<QueryInput>) => AsyncGenerator<SDKMessage>,
    initialInput?: QueryInput | AsyncIterable<QueryInput>,
  ) {
    this.stream = runner(this.queue)

    if (initialInput !== undefined) {
      // A throwing input source must not become an unhandledRejection with the
      // runner left pending forever: fault the queue so the error surfaces as
      // an iterator error inside the message stream.
      void this.streamInput(initialInput)
        .catch((error) => {
          this.queue.fail(error)
        })
        .finally(() => {
          if (!isAsyncIterable<QueryInput>(initialInput)) {
            this.queue.close()
          }
        })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this.stream
  }

  async streamInput(
    input: QueryInput | AsyncIterable<QueryInput>,
  ): Promise<void> {
    if (isAsyncIterable<QueryInput>(input)) {
      for await (const item of input) {
        this.queue.push(item)
      }
      this.queue.close()
      return
    }

    this.queue.push(input)
  }

  async interrupt(): Promise<void> {
    await this.methods.interrupt()
  }

  async setPermissionMode(mode: Parameters<Query['setPermissionMode']>[0]): Promise<void> {
    await this.methods.setPermissionMode(mode)
  }

  async setModel(model?: string): Promise<void> {
    await this.methods.setModel(model)
  }

  async setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void> {
    await this.methods.setMaxThinkingTokens(maxThinkingTokens)
  }

  async setCwd(cwd: string): Promise<void> {
    await this.methods.setCwd(cwd)
  }

  async getInitializationResult(): ReturnType<Query['getInitializationResult']> {
    return this.methods.getInitializationResult()
  }

  async getContextUsage(): ReturnType<Query['getContextUsage']> {
    return this.methods.getContextUsage()
  }

  async reloadPlugins(): ReturnType<Query['reloadPlugins']> {
    return this.methods.reloadPlugins()
  }

  async rewindFiles(
    userMessageId: string,
    dryRun?: boolean,
  ): ReturnType<Query['rewindFiles']> {
    return this.methods.rewindFiles(userMessageId, dryRun)
  }

  async stopTask(taskId: string): Promise<void> {
    await this.methods.stopTask(taskId)
  }
}
