/**
 * 白板 store —— ZCode skillStore `On`(zustand) 的 Lume 落法(Q2 §1)。
 *
 * 规格对齐:
 *  - Board:`{id:'whiteboard:'+uuid, name, width:1280, height:800, strokes,
 *    undoneStrokes, createdAt, updatedAt}`;按 workspaceKey 隔离(ZCode
 *    workspaces[key].boardIds / boardsById)。
 *  - Stroke:`{id:'stroke:'+uuid, tool:'pen'|'eraser', color, width, points}`。
 *  - 持久化:纯内存,无 IPC/磁盘副本(ZCode 同;窗口重开即丢)。
 *  - undo = strokes 弹栈进 undoneStrokes;redo 反向;clear 清空两栈。
 *  - 命名:默认「白板 N」按工作区内既有名去重递增(ZCode _n)。
 */

export type WhiteboardTool = 'pen' | 'eraser'

export interface WhiteboardPoint {
  x: number
  y: number
}

export interface WhiteboardStroke {
  id: string
  tool: WhiteboardTool
  color: string
  width: number
  points: WhiteboardPoint[]
}

export interface WhiteboardBoard {
  id: string
  name: string
  width: number
  height: number
  strokes: WhiteboardStroke[]
  undoneStrokes: WhiteboardStroke[]
  createdAt: number
  updatedAt: number
}

export const WHITEBOARD_WIDTH = 1280
export const WHITEBOARD_HEIGHT = 800

/** ZCode UDt 6 色盘;默认色 #111827。 */
export const WHITEBOARD_PALETTE = ['#111827', '#2563eb', '#16a34a', '#dc2626', '#ca8a04', '#7c3aed'] as const
export const WHITEBOARD_DEFAULT_COLOR = WHITEBOARD_PALETTE[0]
export const WHITEBOARD_MIN_WIDTH = 2
export const WHITEBOARD_MAX_WIDTH = 18
export const WHITEBOARD_DEFAULT_WIDTH = 5
/** 橡皮粗细 = max(14, width*3)(ZCode bn)。 */
export const WHITEBOARD_ERASER_MIN_WIDTH = 14

function newId(prefix: string): string {
  const cryptoRef = globalThis.crypto
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return `${prefix}${cryptoRef.randomUUID()}`
  return `${prefix}${Date.now()}-${Math.floor(Math.random() * 1e9)}`
}

/** ZCode 默认名去重(`_n`):「白板」「白板 2」「白板 3」…。 */
export function dedupeBoardName(existingNames: ReadonlySet<string>, prefix: string): string {
  if (!existingNames.has(prefix)) return prefix
  let ordinal = 2
  while (existingNames.has(`${prefix} ${ordinal}`)) ordinal += 1
  return `${prefix} ${ordinal}`
}

export function eraserWidth(penWidth: number): number {
  return Math.max(WHITEBOARD_ERASER_MIN_WIDTH, penWidth * 3)
}

interface WhiteboardWorkspace {
  boardIds: string[]
  boardsById: Map<string, WhiteboardBoard>
}

const workspaces = new Map<string, WhiteboardWorkspace>()
const listeners = new Set<() => void>()
let storeVersion = 0

function workspaceOf(workspaceKey: string): WhiteboardWorkspace {
  let workspace = workspaces.get(workspaceKey)
  if (!workspace) {
    workspace = { boardIds: [], boardsById: new Map() }
    workspaces.set(workspaceKey, workspace)
  }
  return workspace
}

function notify(): void {
  storeVersion += 1
  for (const listener of [...listeners]) listener()
}

function commit(workspace: WhiteboardWorkspace, board: WhiteboardBoard): void {
  board.updatedAt = Date.now()
  workspace.boardsById.set(board.id, board)
  notify()
}

/* ── 订阅面(React useSyncExternalStore) ────────────────────────────── */

export function subscribeWhiteboards(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getWhiteboardStoreVersion(): number {
  return storeVersion
}

/* ── 查询 ──────────────────────────────────────────────────────────── */

export function listWhiteboardBoards(workspaceKey: string): WhiteboardBoard[] {
  const workspace = workspaces.get(workspaceKey)
  if (!workspace) return []
  return workspace.boardIds
    .map((id) => workspace.boardsById.get(id))
    .filter((board): board is WhiteboardBoard => Boolean(board))
}

export function getWhiteboardBoard(workspaceKey: string, boardId: string): WhiteboardBoard | null {
  return workspaces.get(workspaceKey)?.boardsById.get(boardId) ?? null
}

/* ── 动作(ZCode On action 集全量) ──────────────────────────────────── */

export function createWhiteboardBoard(workspaceKey: string, defaultNamePrefix = '白板'): WhiteboardBoard {
  const workspace = workspaceOf(workspaceKey)
  const existing = new Set(
    workspace.boardIds
      .map((id) => workspace.boardsById.get(id)?.name)
      .filter((name): name is string => Boolean(name)),
  )
  const now = Date.now()
  const board: WhiteboardBoard = {
    id: newId('whiteboard:'),
    name: dedupeBoardName(existing, defaultNamePrefix),
    width: WHITEBOARD_WIDTH,
    height: WHITEBOARD_HEIGHT,
    strokes: [],
    undoneStrokes: [],
    createdAt: now,
    updatedAt: now,
  }
  workspace.boardIds.push(board.id)
  workspace.boardsById.set(board.id, board)
  notify()
  return board
}

export function renameWhiteboardBoard(workspaceKey: string, boardId: string, name: string): void {
  const board = getWhiteboardBoard(workspaceKey, boardId)
  const trimmed = name.trim()
  if (!board || !trimmed || trimmed === board.name) return
  board.name = trimmed
  commit(workspaceOf(workspaceKey), board)
}

export function addWhiteboardStroke(workspaceKey: string, boardId: string, stroke: Omit<WhiteboardStroke, 'id'>): void {
  const board = getWhiteboardBoard(workspaceKey, boardId)
  if (!board || stroke.points.length === 0) return
  board.strokes.push({ ...stroke, id: newId('stroke:') })
  board.undoneStrokes = []
  commit(workspaceOf(workspaceKey), board)
}

export function undoWhiteboardStroke(workspaceKey: string, boardId: string): void {
  const board = getWhiteboardBoard(workspaceKey, boardId)
  const popped = board?.strokes.pop()
  if (!board || !popped) return
  board.undoneStrokes.push(popped)
  commit(workspaceOf(workspaceKey), board)
}

export function redoWhiteboardStroke(workspaceKey: string, boardId: string): void {
  const board = getWhiteboardBoard(workspaceKey, boardId)
  const popped = board?.undoneStrokes.pop()
  if (!board || !popped) return
  board.strokes.push(popped)
  commit(workspaceOf(workspaceKey), board)
}

export function clearWhiteboardBoard(workspaceKey: string, boardId: string): void {
  const board = getWhiteboardBoard(workspaceKey, boardId)
  if (!board) return
  board.strokes = []
  board.undoneStrokes = []
  commit(workspaceOf(workspaceKey), board)
}

/** 测试隔离:清空全部内存态。 */
export function resetWhiteboardStore(): void {
  workspaces.clear()
  notify()
}
