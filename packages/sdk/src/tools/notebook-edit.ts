/**
 * NotebookEditTool - Edit Jupyter notebooks
 *
 * Closer to the Claude-style tool contract:
 * - notebook_path
 * - cell_id
 * - new_source
 * - cell_type
 * - edit_mode
 */

import { readFile, stat } from 'fs/promises'
import { resolve } from 'path'
import { defineTool } from './types.js'
import { writeFileAtomic } from '../utils/fs-atomic.js'
import { ensurePathAllowed, ensureWriteContained, getUnsafeFilePathReason } from '../utils/pathing.js'
import { decodeTextFile, encodeTextFile } from '../utils/text-file.js'

type NotebookCell = {
  id?: string
  cell_type: 'code' | 'markdown'
  source: string[] | string
  metadata?: Record<string, unknown>
  outputs?: unknown[]
  execution_count?: number | null
}

function ensureCellIds(cells: NotebookCell[]): void {
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]
    if (!cell) continue
    if (!cell.id) {
      cell.id = `cell-${i + 1}`
    }
  }
}

function toSourceLines(source: string): string[] {
  return source.split('\n').map((line, index, arr) => (
    index < arr.length - 1 ? `${line}\n` : line
  ))
}

function readCellSource(cell: NotebookCell): string {
  if (Array.isArray(cell.source)) return cell.source.join('')
  return cell.source || ''
}

function resolveNotebookPath(input: any, cwd: string): string {
  const candidate = input.notebook_path || input.file_path
  return resolve(cwd, candidate)
}

function findCellIndex(cells: NotebookCell[], cellId?: string): number {
  if (!cellId) return cells.length > 0 ? 0 : -1
  const direct = cells.findIndex((cell) => cell.id === cellId)
  if (direct >= 0) return direct
  const numeric = Number(cellId)
  if (Number.isInteger(numeric) && numeric >= 0 && numeric < cells.length) {
    return numeric
  }
  return -1
}

function inferLanguage(notebook: any): string {
  return (
    notebook?.metadata?.kernelspec?.language ||
    notebook?.metadata?.language_info?.name ||
    'python'
  )
}

export const NotebookEditTool = defineTool({
  name: 'NotebookEdit',
  description: 'Edit Jupyter notebook cells using notebook_path, cell_id, new_source, and edit_mode. The notebook must be read with Read before the first edit.',
  inputSchema: {
    type: 'object',
    properties: {
      notebook_path: {
        type: 'string',
        description: 'Absolute or relative path to the notebook file',
      },
      cell_id: {
        type: 'string',
        description: 'Target cell ID. For insert, the new cell is inserted after this cell or at the beginning when omitted.',
      },
      new_source: {
        type: 'string',
        description: 'New source content for the cell',
      },
      cell_type: {
        type: 'string',
        enum: ['code', 'markdown'],
        description: 'Required when inserting a cell',
      },
      edit_mode: {
        type: 'string',
        enum: ['replace', 'insert', 'delete'],
        description: 'Edit mode. Defaults to replace.',
      },

      // Backward-compatible legacy shape
      file_path: { type: 'string' },
      command: {
        type: 'string',
        enum: ['insert', 'replace', 'delete'],
      },
      cell_number: { type: 'number' },
      source: { type: 'string' },
    },
    required: ['new_source'],
  },
  isReadOnly: false,
  isConcurrencySafe: false,
  validateInput(input) {
    if (!input || typeof input !== 'object') return 'Input must be an object.'
    const filePath = input.notebook_path || input.file_path
    if (typeof filePath !== 'string' || !filePath.trim()) return 'notebook_path is required.'
    if (!filePath.toLowerCase().endsWith('.ipynb')) return 'notebook_path must point to an .ipynb file.'
    if (input.new_source === undefined && input.source === undefined && input.edit_mode !== 'delete' && input.command !== 'delete') {
      return 'new_source is required for insert and replace.'
    }
  },
  getPath(input, context) {
    return resolve(context.cwd, input.notebook_path || input.file_path)
  },
  async call(input, context) {
    const notebookPath = resolveNotebookPath(input, context.cwd)
    const unsafeReason = getUnsafeFilePathReason(input.notebook_path || input.file_path)
    if (unsafeReason) {
      return { data: unsafeReason, is_error: true }
    }
    const sandboxError = ensurePathAllowed(
      notebookPath,
      'write',
      context.sandbox,
      context.additionalDirectories,
    )
    if (sandboxError) {
      return { data: sandboxError, is_error: true }
    }
    // containment 复核不以沙箱启用为前提（#546）：junction/symlink 可穿越词法边界
    const containmentError = ensureWriteContained(notebookPath, context.cwd, context.additionalDirectories)
    if (containmentError) {
      return { data: containmentError, is_error: true }
    }

    try {
      if (!notebookPath.toLowerCase().endsWith('.ipynb')) {
        return { data: 'Error: NotebookEdit only supports .ipynb files', is_error: true }
      }
      const decoded = decodeTextFile(await readFile(notebookPath))
      const originalFile = decoded.content
      const previousRead = context.fileStateCache?.get(notebookPath)
      // Read-before-edit 强制（#569）：未读过的 notebook 禁止盲改。
      if (!previousRead) {
        // 容量区分（#655）：LRU 驱逐产生的伪未读与真未读分开表述。
        const data = context.fileStateCache?.wasDroppedByCapacity(notebookPath)
          ? `Error: The read record for ${notebookPath} was dropped because the session's file-state cache hit its capacity limit (long sessions drop the oldest records). Read the notebook again, then retry this edit.`
          : `Error: Notebook has not been read yet: ${notebookPath}. Read it first, then retry this edit.`
        return {
          data,
          is_error: true,
          _meta: { file: { path: notebookPath, conflict: 'not_read', retryable: true } },
        }
      }
      if (!previousRead.isPartialView && previousRead.content !== originalFile) {
        return {
          data: 'Error: Notebook has been modified since it was read. Read it again before attempting to edit it.',
          is_error: true,
        }
      }
      const notebook = JSON.parse(originalFile)

      if (!Array.isArray(notebook.cells)) {
        return { data: 'Error: Invalid notebook format', is_error: true }
      }

      const cells = notebook.cells as NotebookCell[]
      ensureCellIds(cells)

      const editMode = (input.edit_mode || input.command || 'replace') as
        | 'replace'
        | 'insert'
        | 'delete'
      const newSource = String(input.new_source ?? input.source ?? '')
      let targetIndex =
        typeof input.cell_number === 'number'
          ? input.cell_number
          : findCellIndex(cells, input.cell_id)

      if (editMode === 'insert') {
        // Omitted anchor inserts at the beginning; explicit anchors insert after
        // the resolved cell (negative cell_number keeps the prepend branch).
        const anchorOmitted = input.cell_id === undefined && input.cell_number === undefined
        const insertAfterIndex = anchorOmitted ? -1 : targetIndex
        const newCell: NotebookCell = {
          id: `cell-${crypto.randomUUID()}`,
          cell_type: input.cell_type || 'code',
          source: toSourceLines(newSource),
          metadata: {},
          ...(input.cell_type !== 'markdown'
            ? { outputs: [], execution_count: null }
            : {}),
        }
        const insertIndex = insertAfterIndex >= 0 ? insertAfterIndex + 1 : 0
        cells.splice(insertIndex, 0, newCell)
        targetIndex = insertIndex
      } else if (editMode === 'replace') {
        if (targetIndex < 0 || targetIndex >= cells.length) {
          return { data: `Error: Cell ${input.cell_id ?? input.cell_number} does not exist`, is_error: true }
        }
        const targetCell = cells[targetIndex]
        if (!targetCell) {
          return { data: `Error: Cell ${input.cell_id ?? input.cell_number} does not exist`, is_error: true }
        }
        targetCell.source = toSourceLines(newSource)
        if (input.cell_type) {
          targetCell.cell_type = input.cell_type
        }
      } else if (editMode === 'delete') {
        if (targetIndex < 0 || targetIndex >= cells.length) {
          return { data: `Error: Cell ${input.cell_id ?? input.cell_number} does not exist`, is_error: true }
        }
        cells.splice(targetIndex, 1)
        targetIndex = Math.max(0, targetIndex - 1)
      }

      ensureCellIds(cells)
      const targetCell = cells[targetIndex]
      let updatedFile = JSON.stringify(notebook, null, 1)
      // 写入瞬间 symlink 复检与 write/edit 同口径（#546）
      await writeFileAtomic(notebookPath, encodeTextFile(updatedFile, decoded), (resolvedPath) =>
        ensureWriteContained(resolvedPath, context.cwd, context.additionalDirectories))
      const updatedStat = await stat(notebookPath)
      context.fileStateCache?.set(notebookPath, {
        content: updatedFile,
        timestamp: updatedStat.mtimeMs,
        isPartialView: false,
      })

      // Only a summary of the changed cell is returned; read the file for full contents.
      return {
        data: JSON.stringify({
          new_source: editMode === 'delete' ? '' : (targetCell ? readCellSource(targetCell) : newSource),
          cell_id: targetCell?.id || input.cell_id,
          cell_type: targetCell?.cell_type || input.cell_type || 'code',
          language: inferLanguage(notebook),
          edit_mode: editMode,
          notebook_path: notebookPath,
        }),
        _meta: {
          file: { path: notebookPath, overwritten: true, checkpointable: true, checkpointId: context.currentUserMessageId },
        },
      }
    } catch (err: any) {
      return { data: `Error: ${err.message}`, is_error: true }
    }
  },
})
