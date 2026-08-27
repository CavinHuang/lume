/**
 * 同 key 动作串行化队列(tails 链)。#610:原 epoch 作废机制(cancel 从无调用方、
 * 校验恒通过,user_takeover_required 因此 100% 不可产出)已随 paused_by_user
 * 接管路径一并移除;排队中的动作被新输入作废的需求由 stale_target/generation
 * 仲裁在动作执行前兜底。
 */
export class BrowserActionQueue {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const execution = previous.then(() => action())
    const tail = execution.then(() => undefined, () => undefined)
    this.tails.set(key, tail)
    try {
      return await execution
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}
