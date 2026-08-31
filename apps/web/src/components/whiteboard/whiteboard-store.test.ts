/**
 * 白板 store 单测(Q2 §1 规格):工作区分桶/默认名查重/undo/redo/clear/
 * 提交清空 undoneStrokes/纯内存订阅。
 */
import { afterEach, describe, expect, test } from 'bun:test'

import {
  createWhiteboardBoard,
  dedupeBoardName,
  eraserWidth,
  getWhiteboardBoard,
  getWhiteboardStoreVersion,
  listWhiteboardBoards,
  addWhiteboardStroke,
  clearWhiteboardBoard,
  redoWhiteboardStroke,
  resetWhiteboardStore,
  undoWhiteboardStroke,
  WHITEBOARD_DEFAULT_COLOR,
  WHITEBOARD_HEIGHT,
  WHITEBOARD_WIDTH,
} from './whiteboard-store'

afterEach(() => resetWhiteboardStore())

const strokeOf = (points: number) => ({ tool: 'pen' as const, color: WHITEBOARD_DEFAULT_COLOR, width: 5, points: Array.from({ length: points }, (_, i) => ({ x: i, y: i })) })

describe('whiteboard store', () => {
  test('boards are workspace-scoped with ZCode fixed size and deduped default names', () => {
    const a = createWhiteboardBoard('ws-1')
    const b = createWhiteboardBoard('ws-1')
    const other = createWhiteboardBoard('ws-2')

    expect(a.id).toStartWith('whiteboard:')
    expect(a.width).toBe(WHITEBOARD_WIDTH)
    expect(a.height).toBe(WHITEBOARD_HEIGHT)
    expect(a.name).toBe('白板')
    expect(b.name).toBe('白板 2')
    expect(other.name).toBe('白板')
    expect(listWhiteboardBoards('ws-1').map((board) => board.id)).toEqual([a.id, b.id])
    expect(getWhiteboardBoard('ws-2', a.id)).toBeNull()
  })

  test('dedupeBoardName follows ZCode 「N」 ordinal scheme', () => {
    expect(dedupeBoardName(new Set(), '白板')).toBe('白板')
    expect(dedupeBoardName(new Set(['白板']), '白板')).toBe('白板 2')
    expect(dedupeBoardName(new Set(['白板', '白板 2', '白板 3']), '白板')).toBe('白板 4')
  })

  test('addStroke commits and clears the redo stack; undo/redo move strokes', () => {
    const board = createWhiteboardBoard('ws-1')
    addWhiteboardStroke('ws-1', board.id, strokeOf(2))
    addWhiteboardStroke('ws-1', board.id, strokeOf(3))
    expect(getWhiteboardBoard('ws-1', board.id)!.strokes).toHaveLength(2)

    undoWhiteboardStroke('ws-1', board.id)
    expect(getWhiteboardBoard('ws-1', board.id)!.strokes).toHaveLength(1)
    expect(getWhiteboardBoard('ws-1', board.id)!.undoneStrokes).toHaveLength(1)

    // 新笔画提交后清空重做栈(ZCode addStroke 语义)
    redoWhiteboardStroke('ws-1', board.id)
    expect(getWhiteboardBoard('ws-1', board.id)!.strokes).toHaveLength(2)
    expect(getWhiteboardBoard('ws-1', board.id)!.undoneStrokes).toHaveLength(0)
    addWhiteboardStroke('ws-1', board.id, strokeOf(1))
    expect(getWhiteboardBoard('ws-1', board.id)!.undoneStrokes).toHaveLength(0)
    expect(getWhiteboardBoard('ws-1', board.id)!.strokes).toHaveLength(3)

    clearWhiteboardBoard('ws-1', board.id)
    expect(getWhiteboardBoard('ws-1', board.id)!.strokes).toHaveLength(0)
    expect(getWhiteboardBoard('ws-1', board.id)!.undoneStrokes).toHaveLength(0)
  })

  test('empty strokes are rejected and mutations bump the store version', () => {
    const before = getWhiteboardStoreVersion()
    const board = createWhiteboardBoard('ws-1')
    addWhiteboardStroke('ws-1', board.id, strokeOf(0))
    expect(getWhiteboardBoard('ws-1', board.id)!.strokes).toHaveLength(0)
    expect(getWhiteboardStoreVersion()).toBeGreaterThan(before)
  })

  test('eraser width = max(14, width*3)', () => {
    expect(eraserWidth(2)).toBe(14)
    expect(eraserWidth(5)).toBe(15)
    expect(eraserWidth(18)).toBe(54)
  })
})
