export class BrowserActionQueue {
  private readonly epochs = new Map<string, number>()
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const epoch = this.epochs.get(key) ?? 0
    const previous = this.tails.get(key) ?? Promise.resolve()
    const execution = previous.then(() => {
      if ((this.epochs.get(key) ?? 0) !== epoch) throw Object.assign(new Error("user_takeover_required"), { code: "user_takeover_required" })
      return action()
    })
    const tail = execution.then(() => undefined, () => undefined)
    this.tails.set(key, tail)
    try {
      return await execution
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }

  cancel(key: string): void {
    this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1)
  }
}
