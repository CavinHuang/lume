import { describe, expect, test } from 'bun:test'
import type { FileRef } from '@lume/shared'
import {
  canDragFileRef,
  FILE_REF_DRAG_MIME,
  formatFileRefMention,
  parseFileRefDragData,
  serializeFileRefDragData,
} from './file-ref-drag'

function transfer(value: string): Pick<DataTransfer, 'getData'> {
  return { getData: (type: string) => type === FILE_REF_DRAG_MIME ? value : '' }
}

describe('file ref drag helpers', () => {
  test('serializes and parses project/session refs without absolute paths', () => {
    const ref: FileRef = { source: 'project', scopeId: 'demo', relativePath: 'src/App.tsx' }

    expect(parseFileRefDragData(transfer(serializeFileRefDragData(ref)))).toEqual(ref)
    expect(formatFileRefMention(ref)).toBe('@project/src/App.tsx')
  })

  test('only allows safe project and session file refs to be dragged', () => {
    expect(canDragFileRef({ source: 'project', scopeId: 'demo', relativePath: 'README.md' })).toBeTrue()
    expect(canDragFileRef({ source: 'memory', scopeId: 'demo', relativePath: 'notes.md' })).toBeFalse()
    expect(canDragFileRef({ source: 'session', scopeId: 'demo', relativePath: '../secret.txt' })).toBeFalse()
    expect(parseFileRefDragData(transfer(JSON.stringify({ source: 'project', scopeId: 'demo', relativePath: '../secret.txt' })))).toBeNull()
  })
})
