const mutationTails = new Map<string, Promise<void>>()

/** Serialize mutations from independent tool runners without merging stale edits. */
export async function withFileMutationLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationTails.get(filePath) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  mutationTails.set(filePath, current)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (mutationTails.get(filePath) === current) mutationTails.delete(filePath)
  }
}
