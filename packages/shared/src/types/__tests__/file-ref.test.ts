import { describe, expect, test } from 'bun:test'
import {
  fileRefChangedEventSchema,
  fileRefReadResultSchema,
  fileRefSchema,
  fileSelectionEditInputSchema,
  guardedFileRefSchema,
  watchFileRefResultSchema,
  writeFileRefInputSchema,
  writeFileRefResultSchema,
  type FileRef,
} from '../file-ref'

// renderer/desktop 与 sidecar 共用本 schema（#288）；以下断言即双方共同的接受面契约。
const validRef = { source: 'project' as const, scopeId: 'demo', relativePath: 'src/app.ts' }

describe('fileRefSchema (single-source IPC contract)', () => {
  test('accepts a valid FileRef and the inferred type matches the historical shape', () => {
    const parsed = fileRefSchema.parse(validRef)
    // 编译期断言：z.infer 推导结果与迁移前手写 interface 结构兼容
    const typed: FileRef = parsed
    expect(typed).toEqual(validRef)
    expect(fileRefSchema.safeParse({ ...validRef, source: 'session' }).success).toBe(true)
    expect(fileRefSchema.safeParse({ ...validRef, source: 'memory' }).success).toBe(true)
    expect(fileRefSchema.safeParse({ ...validRef, source: 'legacy' }).success).toBe(true)
  })

  test('rejects empty or blank scopeId (trim().min(1))', () => {
    expect(fileRefSchema.safeParse({ ...validRef, scopeId: '' }).success).toBe(false)
    expect(fileRefSchema.safeParse({ ...validRef, scopeId: '   ' }).success).toBe(false)
    expect(fileRefSchema.safeParse({ ...validRef, scopeId: undefined }).success).toBe(false)
  })

  test('rejects unknown fields (strict) — renderer and sidecar share the same closed shape', () => {
    expect(
      fileRefSchema.safeParse({ ...validRef, absolutePath: '/etc/passwd' }).success,
    ).toBe(false)
  })

  test('rejects unknown source values', () => {
    expect(fileRefSchema.safeParse({ ...validRef, source: 'absolute' }).success).toBe(false)
  })
})

describe('writeFileRefInputSchema', () => {
  const validWrite = { ref: validRef, content: 'hello', expectedMtimeMs: 123 }

  test('accepts a valid write input', () => {
    expect(writeFileRefInputSchema.safeParse(validWrite).success).toBe(true)
  })

  test('rejects content beyond the 20MB protocol cap', () => {
    expect(
      writeFileRefInputSchema.safeParse({
        ...validWrite,
        content: 'x'.repeat(20 * 1024 * 1024 + 1),
      }).success,
    ).toBe(false)
    expect(
      writeFileRefInputSchema.safeParse({
        ...validWrite,
        content: 'x'.repeat(20 * 1024 * 1024),
      }).success,
    ).toBe(true)
  })

  test('rejects negative or non-finite expectedMtimeMs', () => {
    expect(writeFileRefInputSchema.safeParse({ ...validWrite, expectedMtimeMs: -1 }).success).toBe(false)
    expect(writeFileRefInputSchema.safeParse({ ...validWrite, expectedMtimeMs: Number.NaN }).success).toBe(false)
  })
})

describe('fileSelectionEditInputSchema', () => {
  const validEdit = {
    threadId: 'thread-1',
    ref: validRef,
    content: 'hello world',
    startOffset: 0,
    endOffset: 5,
    instruction: 'Uppercase it',
  }

  test('accepts a valid edit input', () => {
    expect(fileSelectionEditInputSchema.safeParse(validEdit).success).toBe(true)
  })

  test('rejects endOffset past content length or before startOffset', () => {
    expect(fileSelectionEditInputSchema.safeParse({ ...validEdit, endOffset: 20 }).success).toBe(false)
    expect(
      fileSelectionEditInputSchema.safeParse({ ...validEdit, startOffset: 3, endOffset: 2 }).success,
    ).toBe(false)
  })

  test('rejects selections over the 32KB cap', () => {
    expect(
      fileSelectionEditInputSchema.safeParse({
        ...validEdit,
        content: 'x'.repeat(32 * 1024 + 1),
        endOffset: 32 * 1024 + 1,
      }).success,
    ).toBe(false)
  })

  test('rejects blank instruction', () => {
    expect(fileSelectionEditInputSchema.safeParse({ ...validEdit, instruction: '  ' }).success).toBe(false)
  })
})

describe('guardedFileRefSchema', () => {
  const projectGuard = {
    kind: 'project' as const,
    workspaceSlug: 'demo',
    expectedProjectRootFingerprint: 'a'.repeat(64),
    consumerThreadId: 'thread-1',
  }
  const sessionGuard = {
    kind: 'session' as const,
    consumerThreadId: 'thread-1',
    expectedFileContextId: 'fc-1',
  }

  test('accepts project and session branches with their guards', () => {
    expect(
      guardedFileRefSchema.safeParse({ ref: validRef, guard: projectGuard, expectedKind: 'file' }).success,
    ).toBe(true)
    expect(
      guardedFileRefSchema.safeParse({
        ref: { ...validRef, source: 'session' },
        guard: sessionGuard,
        expectedKind: 'directory',
      }).success,
    ).toBe(true)
  })

  test('enforces the 64-hex fingerprint format on project guards', () => {
    expect(
      guardedFileRefSchema.safeParse({
        ref: validRef,
        guard: { ...projectGuard, expectedProjectRootFingerprint: 'nothex' },
        expectedKind: 'file',
      }).success,
    ).toBe(false)
  })

  test('rejects cross-branch pairing (session ref with project guard)', () => {
    expect(
      guardedFileRefSchema.safeParse({
        ref: { ...validRef, source: 'session' },
        guard: projectGuard,
        expectedKind: 'file',
      }).success,
    ).toBe(false)
  })
})

describe('outbound payloads (sidecar → renderer)', () => {
  test('text read result round-trips with encoding metadata', () => {
    const text = {
      kind: 'text' as const,
      content: 'hello',
      size: 5,
      mtimeMs: 123,
      mimeType: 'text/plain',
      encoding: 'utf-8' as const,
      bom: false,
      lineEnding: 'lf' as const,
      editable: true,
      truncated: false as const,
    }
    expect(fileRefReadResultSchema.parse(text)).toEqual(text)
    // text 分支可编辑性受权限与大小限制，运行时可为 false
    expect(fileRefReadResultSchema.safeParse({ ...text, editable: false }).success).toBe(true)
    expect(fileRefReadResultSchema.safeParse({ ...text, encoding: 'base64' }).success).toBe(false)
  })

  test('binary/too-large read result pins editable=false truncated=true', () => {
    const binary = {
      kind: 'binary' as const,
      size: 10,
      mtimeMs: 1,
      mimeType: 'image/png',
      editable: false as const,
      truncated: true as const,
    }
    expect(fileRefReadResultSchema.safeParse(binary).success).toBe(true)
    expect(
      fileRefReadResultSchema.safeParse({
        ...binary,
        kind: 'too-large',
        editable: true,
      }).success,
    ).toBe(false)
  })

  test('write result only allows saved/conflict outcomes', () => {
    expect(writeFileRefResultSchema.safeParse({ outcome: 'saved', mtimeMs: 1, size: 2 }).success).toBe(true)
    expect(writeFileRefResultSchema.safeParse({ outcome: 'conflict', mtimeMs: 1, size: 2 }).success).toBe(true)
    expect(writeFileRefResultSchema.safeParse({ outcome: 'deleted', mtimeMs: 1, size: 2 }).success).toBe(false)
  })

  test('watch result and changed event shapes stay closed', () => {
    expect(watchFileRefResultSchema.safeParse({ watchId: 'w-1' }).success).toBe(true)
    expect(watchFileRefResultSchema.safeParse({ watchId: 'w-1', extra: 1 }).success).toBe(false)
    const event = { watchId: 'w-1', ref: validRef, change: 'renamed' as const, mtimeMs: 9 }
    expect(fileRefChangedEventSchema.parse(event)).toEqual(event)
    expect(fileRefChangedEventSchema.safeParse({ ...event, change: 'moved' }).success).toBe(false)
  })
})
