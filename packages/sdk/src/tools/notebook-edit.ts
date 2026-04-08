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

import { readFile, writeFile } from 'fs/promises'
import { resolve } from 'path'
import { defineTool } from './types.js'
import { ensurePathAllowed } from '../utils/pathing.js'

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
    if (!cells[i].id) {
      cells[i].id = `cell-${i + 1}`
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
  description: 'Edit Jupyter notebook cells using notebook_path, cell_id, new_source, and edit_mode.',
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
  async call(input, context) {
    const notebookPath = resolveNotebookPath(input, context.cwd)
    const sandboxError = ensurePathAllowed(
      notebookPath,
      'write',
      context.sandbox,
      context.additionalDirectories,
    )
    if (sandboxError) {
      return { data: sandboxError, is_error: true }
    }

    try {
      const originalFile = await readFile(notebookPath, 'utf-8')
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
        const insertAfterIndex = targetIndex
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
        cells[targetIndex].source = toSourceLines(newSource)
        if (input.cell_type) {
          cells[targetIndex].cell_type = input.cell_type
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
      const updatedFile = JSON.stringify(notebook, null, 1)
      await writeFile(notebookPath, updatedFile, 'utf-8')

      return JSON.stringify({
        new_source: editMode === 'delete' ? '' : (targetCell ? readCellSource(targetCell) : newSource),
        cell_id: targetCell?.id || input.cell_id,
        cell_type: targetCell?.cell_type || input.cell_type || 'code',
        language: inferLanguage(notebook),
        edit_mode: editMode,
        notebook_path: notebookPath,
        original_file: originalFile,
        updated_file: updatedFile,
      })
    } catch (err: any) {
      return { data: `Error: ${err.message}`, is_error: true }
    }
  },
})
