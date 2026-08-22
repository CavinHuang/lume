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
  private resolvers: Array<(value: IteratorResult<QueryInput>) => void> = []
  private closed = false

  push(item: QueryInput): void {
    if (this.closed) {
      throw new Error('Query input stream is closed')
    }

    const resolver = this.resolvers.shift()
    if (resolver) {
      resolver({ done: false, value: item })
      return
    }

    this.items.push(item)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()
      resolver?.({ done: true, value: undefined as never })
    }
  }

  async next(): Promise<IteratorResult<QueryInput>> {
    const item = this.items.shift()
    if (item !== undefined) {
      return { done: false, value: item }
    }

    if (this.closed) {
      return { done: true, value: undefined as never }
    }

    return new Promise<IteratorResult<QueryInput>>((resolve) => {
      this.resolvers.push(resolve)
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
      void this.streamInput(initialInput).finally(() => {
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
