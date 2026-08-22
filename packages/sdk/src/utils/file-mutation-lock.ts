import { toPathKey } from './pathing.js'

const mutationTails = new Map<string, Promise<void>>()

/** Serialize mutations from independent tool runners without merging stale edits. */
export async function withFileMutationLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  // 大小写归一键：win32/darwin 异写法路径必须命中同一把锁（#334）
  const key = toPathKey(filePath)
  const previous = mutationTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  mutationTails.set(key, current)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (mutationTails.get(key) === current) mutationTails.delete(key)
  }
}
