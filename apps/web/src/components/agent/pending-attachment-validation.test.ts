import { describe, expect, test } from 'bun:test'
import {
  MAX_PENDING_ATTACHMENT_FILE_BYTES,
  MAX_PENDING_ATTACHMENT_TOTAL_BYTES,
  validatePendingAttachmentBatch,
} from './pending-attachment-validation'

const file = (filename: string, size: number) => ({ filename, size })

describe('validatePendingAttachmentBatch', () => {
  test('keeps valid files while rejecting invalid files individually', () => {
    const result = validatePendingAttachmentBatch([], [
      file('ok.txt', 10),
      file('large.bin', MAX_PENDING_ATTACHMENT_FILE_BYTES + 1),
      file('bad.bin', -1),
    ])

    expect(result.accepted.map((item) => item.filename)).toEqual(['ok.txt'])
    expect(result.rejected.map((item) => item.reason)).toEqual(['file_too_large', 'invalid_size'])
  })

  test('applies count and total limits incrementally', () => {
    const totalResult = validatePendingAttachmentBatch([
      file('a.bin', MAX_PENDING_ATTACHMENT_TOTAL_BYTES / 2),
      file('b.bin', MAX_PENDING_ATTACHMENT_TOTAL_BYTES / 2),
    ], [file('over-total.bin', 1), file('empty.bin', 0)])
    expect(totalResult.accepted.map((item) => item.filename)).toEqual(['empty.bin'])
    expect(totalResult.rejected.map((item) => item.reason)).toEqual(['total_limit'])

    const countResult = validatePendingAttachmentBatch(
      Array.from({ length: 9 }, (_, index) => file(`${index}.txt`, 0)),
      [file('tenth.txt', 0), file('eleventh.txt', 0)],
    )
    expect(countResult.accepted.map((item) => item.filename)).toEqual(['tenth.txt'])
    expect(countResult.rejected.map((item) => item.reason)).toEqual(['count_limit'])
  })
})
