export class BrowserActionQueue {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const execution = previous.then(action)
    const tail = execution.then(() => undefined, () => undefined)
    this.tails.set(key, tail)
    try {
      return await execution
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}
