import { describe, expect, test } from 'bun:test'
import { fileRefInputSchema, fileSelectionEditInputSchema, guardedFileRefInputSchema } from './schemas'

const projectRef = { source: 'project' as const, scopeId: 'demo', relativePath: 'src/app.ts' }
const projectGuard = {
  kind: 'project' as const,
  workspaceSlug: 'demo',
  expectedProjectRootFingerprint: 'a'.repeat(64),
  consumerThreadId: 'thread-1',
}

describe('message file reference schemas', () => {
  test('guarded endpoints fail closed when the mandatory guard is missing or malformed', () => {
    expect(guardedFileRefInputSchema.safeParse({ guardedRef: { ref: projectRef } }).success).toBe(false)
    expect(guardedFileRefInputSchema.safeParse({ guardedRef: { ref: projectRef, guard: { ...projectGuard, expectedProjectRootFingerprint: 'short' } } }).success).toBe(false)
    expect(guardedFileRefInputSchema.safeParse({ guardedRef: { ref: { ...projectRef, source: 'session' }, guard: projectGuard } }).success).toBe(false)
  })

  test('plain and guarded endpoint inputs stay structurally separate', () => {
    const guardedRef = { ref: projectRef, guard: projectGuard, expectedKind: 'file' }
    expect(guardedFileRefInputSchema.safeParse({ guardedRef }).success).toBe(true)
    expect(fileRefInputSchema.safeParse({ ref: projectRef }).success).toBe(true)
    expect(guardedFileRefInputSchema.safeParse({ ref: projectRef }).success).toBe(false)
    expect(fileRefInputSchema.safeParse({ guardedRef }).success).toBe(false)
  })

  test('selection edits reject stale or oversized ranges at the RPC boundary', () => {
    const valid = {
      threadId: 'thread-1',
      ref: projectRef,
      content: 'hello world',
      startOffset: 0,
      endOffset: 5,
      instruction: 'Uppercase it',
    }
    expect(fileSelectionEditInputSchema.safeParse(valid).success).toBe(true)
    expect(fileSelectionEditInputSchema.safeParse({ ...valid, endOffset: 20 }).success).toBe(false)
    expect(fileSelectionEditInputSchema.safeParse({
      ...valid,
      content: 'x'.repeat(32 * 1024 + 1),
      endOffset: 32 * 1024 + 1,
    }).success).toBe(false)
  })
})
