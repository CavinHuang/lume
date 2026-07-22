/**
 * LSPTool - real Language Server Protocol code intelligence.
 *
 * The SDK owns the JSON-RPC client, while the language server remains an
 * external process. Configure `toolConfig.lsp.command`/`args` when the
 * workspace does not expose `typescript-language-server --stdio`.
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defineTool } from './types.js'
import type { ToolContext } from '../types.js'
import { ensurePathAllowed } from '../utils/pathing.js'
import {
  applyTextEdits,
  collectLspDiagnostics,
  filePathFromUri,
  getLspClientsForFile,
  notifyLspFileClosed,
  notifyLspFileChanged,
  requestLspClients,
  type LspClient,
  type LspLocation,
  type LspLocationLink,
  type LspTextEdit,
  type LspWorkspaceEdit,
} from '../lsp/client.js'

const locationOperations = new Set([
  'goToDefinition',
  'findReferences',
  'goToImplementation',
])

const LSP_MUTATION_OPERATIONS = new Set(['rename', 'codeActions', 'formatting', 'rangeFormatting', 'applyWorkspaceEdit'])
const LSP_READONLY_REQUESTS = new Set([
  'textDocument/definition',
  'textDocument/references',
  'textDocument/implementation',
  'textDocument/typeDefinition',
  'textDocument/hover',
  'textDocument/documentSymbol',
  'textDocument/prepareRename',
  'textDocument/prepareCallHierarchy',
  'callHierarchy/incomingCalls',
  'callHierarchy/outgoingCalls',
  'textDocument/diagnostic',
  'workspace/symbol',
])

function isMutationRequest(operation: string, input: Record<string, any>): boolean {
  if (operation === 'request') return !LSP_READONLY_REQUESTS.has(typeof input.query === 'string' ? input.query.trim() : '')
  if (!LSP_MUTATION_OPERATIONS.has(operation)) return false
  return operation === 'rename' || operation === 'applyWorkspaceEdit' ? input.apply !== false : input.apply === true
}

function createLspTool(allowWrite: boolean) {
  return defineTool({
  name: allowWrite ? 'LSPApply' : 'LSP',
  description: allowWrite
    ? 'Apply Language Server Protocol edits: rename, formatting, code actions, and WorkspaceEdit.'
    : 'Read-only Language Server Protocol code intelligence: definitions, references, hover, symbols, diagnostics, call hierarchy, and previews.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: [
          'goToDefinition',
          'definition',
          'findReferences',
          'references',
          'hover',
          'documentSymbol',
          'symbols',
          'workspaceSymbol',
          'goToImplementation',
          'implementation',
          'typeDefinition',
          'prepareRename',
          'prepareCallHierarchy',
          'incomingCalls',
          'outgoingCalls',
          'diagnostics',
          'rename',
          'codeActions',
      'formatting',
          'rangeFormatting',
          'applyWorkspaceEdit',
          'status',
          'capabilities',
          'reload',
          'request',
        ],
      },
      file_path: { type: 'string', description: 'Workspace-relative or absolute file path' },
      line: { type: 'number', description: '0-based line' },
      character: { type: 'number', description: '0-based UTF-16 character' },
      query: { type: 'string', description: 'Workspace symbol query' },
      new_name: { type: 'string', description: 'New symbol name for rename' },
      item: { type: 'object', description: 'Call hierarchy item returned by prepareCallHierarchy' },
      diagnostics: { type: 'array', description: 'Diagnostics passed to textDocument/codeAction' },
      only: { type: 'array', description: 'Code action kinds to request' },
      apply: { type: 'boolean', description: 'Apply returned edits; false returns a preview' },
      action_index: { type: 'number', description: 'Code action index to apply' },
      end_line: { type: 'number', description: 'Optional range end line' },
      end_character: { type: 'number', description: 'Optional range end character' },
      tab_size: { type: 'number', description: 'Formatting tab size' },
      insert_spaces: { type: 'boolean', description: 'Formatting should use spaces' },
      payload: { type: ['object', 'string'], description: 'Raw JSON-RPC request payload' },
      server: { type: 'string', description: 'Optional LSP server name for a write operation or raw request' },
    },
    required: ['operation'],
  },
  isReadOnly: !allowWrite,
  isConcurrencySafe: !allowWrite,
  async prompt() {
    return 'Code intelligence backed by an external Language Server Protocol server.'
  },
  async call(input, context) {
    try {
      const operation = String(input.operation ?? '')
      if (isMutationRequest(operation, input) !== allowWrite) {
        return {
          data: allowWrite
            ? 'LSPApply only accepts operations that apply a mutation'
            : 'This LSP operation is read-only; use LSPApply to modify files',
          is_error: true,
        }
      }
      const filePath = input.file_path ? resolve(context.cwd, String(input.file_path)) : undefined
      if (filePath) {
        const sandboxError = ensurePathAllowed(
          filePath,
          'read',
          context.sandbox,
          context.additionalDirectories,
        )
        if (sandboxError) return { data: sandboxError, is_error: true }
      }
      if (locationOperations.has(operation) || ['definition', 'references', 'implementation', 'typeDefinition', 'hover', 'documentSymbol', 'symbols', 'rename', 'prepareRename', 'diagnostics', 'prepareCallHierarchy', 'codeActions', 'formatting', 'rangeFormatting'].includes(operation)) {
        if (!filePath) return { data: 'file_path is required for this operation', is_error: true }
        if (operation !== 'diagnostics' && (typeof input.line !== 'number' || typeof input.character !== 'number')) {
          return { data: 'line and character are required for this operation', is_error: true }
        }
      }
      if ((operation === 'incomingCalls' || operation === 'outgoingCalls') && !input.item) {
        return { data: 'item is required for call hierarchy traversal', is_error: true }
      }

      const clients = await getLspClientsForFile(context.cwd, context.toolConfig, filePath)
      const client = selectClient(clients, input.server)
      if (!client) return { data: 'No matching LSP server is available', is_error: true }
      if (filePath) await Promise.all(clients.map((candidate) => candidate.syncFile(filePath)))
      const request = <T>(method: string, params: unknown, timeoutMs = 15_000) =>
        client.request<T>(method, params, timeoutMs, context.abortSignal)
      const requestAll = <T>(method: string, params: unknown, timeoutMs = 15_000) =>
        requestLspClients<T>(clients, method, params, timeoutMs, context.abortSignal)
      const position = filePath
        ? { line: Number(input.line), character: Number(input.character) }
        : undefined
      const endPosition = filePath && typeof input.end_line === 'number' && typeof input.end_character === 'number'
        ? { line: Number(input.end_line), character: Number(input.end_character) }
        : position
      let result: unknown

      switch (operation) {
        case 'goToDefinition':
        case 'definition':
          result = aggregateLocations(await requestAll('textDocument/definition', { textDocument: { uri: uriFor(filePath!) }, position }))
          break
        case 'findReferences':
        case 'references':
          result = aggregateLocations(await requestAll('textDocument/references', {
            textDocument: { uri: uriFor(filePath!) }, position, context: { includeDeclaration: true },
          }))
          break
        case 'goToImplementation':
        case 'implementation':
          result = aggregateLocations(await requestAll('textDocument/implementation', { textDocument: { uri: uriFor(filePath!) }, position }))
          break
        case 'typeDefinition':
          result = aggregateLocations(await requestAll('textDocument/typeDefinition', { textDocument: { uri: uriFor(filePath!) }, position }))
          break
        case 'hover':
          result = firstNonEmptyServerResult(await requestAll('textDocument/hover', { textDocument: { uri: uriFor(filePath!) }, position }))
          break
        case 'documentSymbol':
        case 'symbols':
          result = aggregateServerArrays(await requestAll('textDocument/documentSymbol', { textDocument: { uri: uriFor(filePath!) } }))
          break
        case 'workspaceSymbol':
          if (!input.query) return { data: 'query is required for workspaceSymbol', is_error: true }
          result = aggregateServerArrays(await requestAll('workspace/symbol', { query: String(input.query) }))
          break
        case 'prepareCallHierarchy':
          result = aggregateServerArrays(await requestAll('textDocument/prepareCallHierarchy', { textDocument: { uri: uriFor(filePath!) }, position }))
          break
        case 'prepareRename':
          result = firstNonEmptyServerResult(await requestAll('textDocument/prepareRename', { textDocument: { uri: uriFor(filePath!) }, position }))
          break
        case 'incomingCalls':
          if (!input.item) return { data: 'item is required for incomingCalls', is_error: true }
          result = aggregateServerArrays(await requestAll('callHierarchy/incomingCalls', { item: input.item }))
          break
        case 'outgoingCalls':
          if (!input.item) return { data: 'item is required for outgoingCalls', is_error: true }
          result = aggregateServerArrays(await requestAll('callHierarchy/outgoingCalls', { item: input.item }))
          break
        case 'diagnostics':
          result = formatDiagnostics(await collectLspDiagnostics(clients, filePath!, 3_000, context.abortSignal), filePath!, context.cwd)
          break
        case 'codeActions': {
          const actionResults = await requestAll<unknown[]>('textDocument/codeAction', {
            textDocument: { uri: uriFor(filePath!) },
            range: { start: position, end: endPosition },
            context: {
              diagnostics: Array.isArray(input.diagnostics) ? input.diagnostics : [],
              ...(Array.isArray(input.only) && input.only.length > 0 ? { only: input.only } : {}),
            },
          })
          const resolvedActions = (await Promise.all(actionResults.map(async ({ server, result: actions }) =>
            (await resolveCodeActions(selectClient(clients, server)!, actions ?? [])).map((action) => ({
              ...action,
              server,
              ...(action.edit ? { preview: formatWorkspaceEditPreview(action.edit, context.cwd, server) } : {}),
            }))
          ))).flat()
          result = resolvedActions
          if (input.apply === true) {
            const selected = selectCodeAction(resolvedActions, input.action_index)
            if (!selected) return { data: 'No applicable code action returned', is_error: true }
            const changedFiles = selected.edit ? await applyWorkspaceEdit(selected.edit, context) : []
            const actionClient = selectClient(clients, selected.server)
            const commandResult = selected.command && typeof selected.command === 'object' && actionClient
              ? await actionClient.request('workspace/executeCommand', selected.command, 15_000, context.abortSignal)
              : undefined
            result = {
              applied: changedFiles,
              ...(selected.command ? { command: selected.command } : {}),
              ...(commandResult !== undefined ? { commandResult } : {}),
              title: selected.title,
            }
          }
          break
        }
        case 'formatting':
        case 'rangeFormatting': {
          const formattingClient = selectFormattingClient(clients, input.server)
          if (!formattingClient) return { data: 'No LSP server supports formatting', is_error: true }
          const formattingOptions = await resolveFormattingOptions(filePath!, input)
          const edits = await formattingClient.request<LspTextEdit[]>(operation === 'rangeFormatting' ? 'textDocument/rangeFormatting' : 'textDocument/formatting', {
            textDocument: { uri: uriFor(filePath!) },
            ...(operation === 'rangeFormatting' ? { range: { start: position, end: endPosition } } : {}),
            options: formattingOptions,
          }, 15_000, context.abortSignal)
          if (input.apply === true) {
            result = { changedFiles: await applyTextEditsWorkspace(filePath!, edits ?? [], context) }
          } else {
            result = { server: formattingClient.serverName, preview: edits ?? [] }
          }
          break
        }
        case 'status':
          result = clients.map((candidate) => candidate.getStatus())
          break
        case 'capabilities':
          result = clients.map((candidate) => ({ server: candidate.serverName, capabilities: candidate.getStatus().capabilities }))
          break
        case 'reload':
          await Promise.all(clients.map((candidate) => candidate.reload()))
          result = { reloaded: clients.map((candidate) => candidate.serverName) }
          break
        case 'request': {
          const method = typeof input.query === 'string' ? input.query.trim() : ''
          if (!method) return { data: 'query is required for request', is_error: true }
          const payload = typeof input.payload === 'string'
            ? JSON.parse(input.payload)
            : input.payload ?? (filePath ? { textDocument: { uri: uriFor(filePath!) }, ...(position ? { position } : {}) } : {})
          result = await client.request(method, payload, 15_000, context.abortSignal)
          break
        }
        case 'applyWorkspaceEdit': {
          const payload = typeof input.payload === 'string' ? JSON.parse(input.payload) : input.payload
          if (!payload || typeof payload !== 'object') return { data: 'payload must be a WorkspaceEdit object', is_error: true }
          result = { server: client.serverName, changedFiles: await applyWorkspaceEdit(payload as LspWorkspaceEdit, context) }
          break
        }
        case 'rename': {
          if (!input.new_name || !/^[A-Za-z_$][\w$]*$/.test(String(input.new_name))) {
            return { data: 'new_name must be a valid identifier', is_error: true }
          }
          const renameClient = await selectRenameClient(clients, filePath!, position!, context.abortSignal, input.server)
          if (!renameClient) return { data: 'No LSP server accepted prepareRename', is_error: true }
          const edit = await renameClient.request<LspWorkspaceEdit>('textDocument/rename', {
            textDocument: { uri: uriFor(filePath!) }, position, newName: String(input.new_name),
          }, 15_000, context.abortSignal)
          if (input.apply === false) {
            result = {
              server: renameClient.serverName,
              preview: formatWorkspaceEditPreview(edit, context.cwd, renameClient.serverName),
              message: `Rename preview for ${input.new_name}`,
            }
          } else {
            const changedFiles = await applyWorkspaceEdit(edit, context)
            result = { server: renameClient.serverName, changedFiles, message: `Renamed symbol to ${input.new_name}` }
          }
          break
        }
        default:
          return { data: `Unsupported LSP operation: ${operation}`, is_error: true }
      }

      return { data: formatResult(result) }
    } catch (error) {
      return {
        data: `LSP error: ${error instanceof Error ? error.message : String(error)}. Install/configure a language server (for TypeScript: typescript-language-server --stdio).`,
        is_error: true,
      }
    }
  },
  })
}

export const LSPTool = createLspTool(false)
export const LSPApplyTool = createLspTool(true)

function uriFor(filePath: string): string {
  return pathToFileURL(filePath).toString()
}

function selectClient(clients: LspClient[], server: unknown): LspClient | undefined {
  if (typeof server === 'string' && server.trim()) return clients.find((client) => client.serverName === server.trim())
  return clients[0]
}

function selectFormattingClient(clients: LspClient[], server: unknown): LspClient | undefined {
  return (typeof server === 'string' && server.trim()
    ? clients.filter((client) => client.serverName === server.trim())
    : clients
  ).find((client) => Boolean(client.getStatus().capabilities.documentFormattingProvider || client.getStatus().capabilities.formattingProvider))
}

async function resolveFormattingOptions(filePath: string, input: Record<string, any>): Promise<{ tabSize: number; insertSpaces: boolean }> {
  if (typeof input.tab_size === 'number' && typeof input.insert_spaces === 'boolean') {
    return { tabSize: Math.max(1, Math.floor(input.tab_size)), insertSpaces: input.insert_spaces }
  }
  let content = ''
  try { content = await readFile(filePath, 'utf8') } catch { /* server fallback */ }
  const indentation = content.split(/\r?\n/).map((line) => line.match(/^( +|\t+)/)?.[1]).find(Boolean)
  const insertSpaces = typeof input.insert_spaces === 'boolean' ? input.insert_spaces : !indentation?.includes('\t')
  const detectedSpaces = indentation && !indentation.includes('\t') ? indentation.length : 2
  const tabSize = typeof input.tab_size === 'number' ? Math.max(1, Math.floor(input.tab_size)) : detectedSpaces
  return { tabSize, insertSpaces }
}

async function selectRenameClient(
  clients: LspClient[],
  filePath: string,
  position: { line: number; character: number },
  signal: AbortSignal | undefined,
  server: unknown,
): Promise<LspClient | undefined> {
  const candidates = typeof server === 'string' && server.trim()
    ? clients.filter((client) => client.serverName === server.trim())
    : clients
  const results = await Promise.all(candidates.map(async (client) => {
    try {
      const prepared = await client.request<unknown>('textDocument/prepareRename', {
        textDocument: { uri: uriFor(filePath) }, position,
      }, 15_000, signal)
      return prepared ? client : undefined
    } catch {
      return undefined
    }
  }))
  return results.find((client): client is LspClient => Boolean(client))
}

function aggregateLocations(results: Array<{ server: string; result: unknown }>): unknown[] {
  const seen = new Set<string>()
  const output: unknown[] = []
  for (const { server, result } of results) {
    const values = Array.isArray(result) ? result : result ? [result] : []
    for (const value of values) {
      if (!value || typeof value !== 'object') continue
      const record = value as Record<string, unknown>
      const uri = typeof record.uri === 'string' ? record.uri : typeof record.targetUri === 'string' ? record.targetUri : ''
      const range = record.range ?? record.targetRange
      const key = `${uri}|${JSON.stringify(range)}|${String(record.name ?? '')}`
      if (seen.has(key)) continue
      seen.add(key)
      output.push({ ...record, server })
    }
  }
  return output.sort(compareLspResultPosition)
}

function aggregateServerArrays(results: Array<{ server: string; result: unknown }>): unknown[] {
  const seen = new Set<string>()
  const output: unknown[] = []
  for (const { server, result } of results) {
    const values = Array.isArray(result) ? result : result ? [result] : []
    for (const value of values) {
      if (!value || typeof value !== 'object') continue
      const record = value as Record<string, unknown>
      const key = JSON.stringify([record.name, record.kind, record.uri, record.range, record.selectionRange, record.location])
      if (seen.has(key)) continue
      seen.add(key)
      output.push({ ...record, server })
    }
  }
  return output.sort(compareLspResultPosition)
}

function compareLspResultPosition(left: unknown, right: unknown): number {
  const a = left && typeof left === 'object' ? left as Record<string, any> : {}
  const b = right && typeof right === 'object' ? right as Record<string, any> : {}
  const aUri = String(a.uri ?? a.targetUri ?? a.location?.uri ?? '')
  const bUri = String(b.uri ?? b.targetUri ?? b.location?.uri ?? '')
  if (aUri !== bUri) return aUri.localeCompare(bUri)
  const aRange = a.range ?? a.targetRange ?? a.location?.range
  const bRange = b.range ?? b.targetRange ?? b.location?.range
  return (aRange?.start?.line ?? 0) - (bRange?.start?.line ?? 0)
    || (aRange?.start?.character ?? 0) - (bRange?.start?.character ?? 0)
}

function firstNonEmptyServerResult(results: Array<{ server: string; result: unknown }>): unknown {
  const result = results.find((entry) => entry.result !== null && entry.result !== undefined)
  return result ? { server: result.server, ...(result.result && typeof result.result === 'object' ? result.result as Record<string, unknown> : { value: result.result }) } : null
}

function formatResult(result: unknown): string {
  if (result === null || result === undefined) return 'No result'
  if (typeof result === 'string') return result
  if (Array.isArray(result) && result.length === 0) return 'No result'
  return JSON.stringify(normalizeLocations(result), null, 2)
}

function formatDiagnostics(diagnostics: Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; severity?: number; code?: string | number; source?: string; server?: string; message: string }>, filePath: string, cwd: string): string {
  if (diagnostics.length === 0) return 'OK'
  const severity = (value?: number) => ({ 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }[value ?? 1] ?? 'error')
  const relativePath = relative(cwd, filePath) || filePath
  return diagnostics
    .sort((left, right) => left.range.start.line - right.range.start.line || left.range.start.character - right.range.start.character)
    .map((diagnostic) => `${relativePath}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${severity(diagnostic.severity)}${diagnostic.code !== undefined ? ` [${diagnostic.code}]` : ''}${diagnostic.server ? ` (${diagnostic.server}${diagnostic.source ? `:${diagnostic.source}` : ''})` : diagnostic.source ? ` (${diagnostic.source})` : ''}: ${diagnostic.message}`)
    .join('\n')
}

interface LspCodeActionValue {
  title: string
  kind?: string
  edit?: LspWorkspaceEdit
  command?: unknown
  data?: unknown
  isPreferred?: boolean
  disabled?: { reason: string }
  server?: string
  preview?: LspWorkspaceEditPreview
}

async function resolveCodeActions(client: LspClient, actions: unknown[]): Promise<LspCodeActionValue[]> {
  const provider = client.getStatus().capabilities.codeActionProvider
  const canResolve = Boolean(provider && typeof provider === 'object' && (provider as Record<string, unknown>).resolveProvider)
  const normalized = actions.filter((value): value is LspCodeActionValue => Boolean(value && typeof value === 'object' && typeof (value as Record<string, unknown>).title === 'string'))
  if (!canResolve) return normalized
  return await Promise.all(normalized.map(async (action) => {
    if (action.edit || action.command || action.data === undefined) return action
    try {
      return await client.request<LspCodeActionValue>('codeAction/resolve', action, 15_000)
    } catch {
      return action
    }
  }))
}

function selectCodeAction(actions: LspCodeActionValue[], index: unknown): LspCodeActionValue | undefined {
  if (typeof index === 'number' && Number.isInteger(index)) return actions[index]
  return actions.find((action) => action.isPreferred && !action.disabled) ?? actions.find((action) => !action.disabled)
}

function normalizeLocations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeLocations)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  if (typeof record.uri === 'string' && record.range) return locationSummary(record as unknown as LspLocation)
  if (typeof record.targetUri === 'string' && record.targetRange) return locationLinkSummary(record as unknown as LspLocationLink)
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, normalizeLocations(item)]))
}

function locationSummary(location: LspLocation): Record<string, unknown> {
  return {
    file: safeFilePath(location.uri),
    range: location.range,
    ...(typeof (location as LspLocation & { server?: unknown }).server === 'string' ? { server: (location as LspLocation & { server: string }).server } : {}),
  }
}

function locationLinkSummary(location: LspLocationLink): Record<string, unknown> {
  return {
    file: safeFilePath(location.targetUri),
    range: location.targetSelectionRange ?? location.targetRange,
    ...(typeof (location as LspLocationLink & { server?: unknown }).server === 'string' ? { server: (location as LspLocationLink & { server: string }).server } : {}),
  }
}

function safeFilePath(uri: string): string {
  try { return filePathFromUri(uri) } catch { return uri }
}

export interface LspWorkspaceEditPreview {
  files: string[]
  edits: number
  operations: Array<{ server: string; kind: 'edit' | 'create' | 'rename' | 'delete'; path: string }>
}

function formatWorkspaceEditPreview(edit: LspWorkspaceEdit | null | undefined, cwd: string, server = 'default'): LspWorkspaceEditPreview {
  if (!edit) return { files: [], edits: 0, operations: [] }
  const files = new Set<string>()
  const operations: LspWorkspaceEditPreview['operations'] = []
  let editCount = 0
  for (const [uri, fileEdits] of Object.entries(edit.changes ?? {})) {
    const filePath = safeFilePath(uri)
    files.add(relative(cwd, filePath) || filePath)
    editCount += fileEdits.length
    operations.push({ server, kind: 'edit', path: relative(cwd, filePath) || filePath })
  }
  for (const change of edit.documentChanges ?? []) {
    if ('textDocument' in change) {
      const filePath = safeFilePath(change.textDocument.uri)
      files.add(relative(cwd, filePath) || filePath)
      editCount += change.edits.length
      operations.push({ server, kind: 'edit', path: relative(cwd, filePath) || filePath })
    } else if (change.kind === 'create') {
      const filePath = safeFilePath(change.uri)
      files.add(relative(cwd, filePath) || filePath)
      operations.push({ server, kind: 'create', path: relative(cwd, filePath) || filePath })
    } else if (change.kind === 'rename') {
      const oldPath = safeFilePath(change.oldUri)
      const newPath = safeFilePath(change.newUri)
      files.add(relative(cwd, oldPath) || oldPath)
      files.add(relative(cwd, newPath) || newPath)
      operations.push({ server, kind: 'rename', path: `${relative(cwd, oldPath) || oldPath} -> ${relative(cwd, newPath) || newPath}` })
    } else if (change.kind === 'delete') {
      const filePath = safeFilePath(change.uri)
      files.add(relative(cwd, filePath) || filePath)
      operations.push({ server, kind: 'delete', path: relative(cwd, filePath) || filePath })
    }
  }
  return { files: [...files], edits: editCount, operations }
}

async function applyTextEditsWorkspace(filePath: string, edits: LspTextEdit[], context: ToolContext): Promise<string[]> {
  const absolute = resolve(context.cwd, filePath)
  assertWriteAllowed(absolute, context)
  const original = await readFile(absolute, 'utf8')
  const updated = applyTextEdits(original, edits)
  if (updated === original) return []
  await writeFileAtomic(absolute, updated)
  await notifyLspFileChanged(absolute)
  return [absolute]
}

async function applyWorkspaceEdit(edit: LspWorkspaceEdit | null | undefined, context: ToolContext): Promise<string[]> {
  if (!edit) return []
  type WorkspaceStep =
    | { kind: 'edit'; path: string; edits: LspTextEdit[] }
    | { kind: 'create'; path: string; options?: { overwrite?: boolean; ignoreIfExists?: boolean } }
    | { kind: 'rename'; oldPath: string; newPath: string; options?: { overwrite?: boolean; ignoreIfExists?: boolean } }
    | { kind: 'delete'; path: string; options?: { recursive?: boolean; ignoreIfNotExists?: boolean } }

  const steps: WorkspaceStep[] = []
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    steps.push({ kind: 'edit', path: resolve(context.cwd, filePathFromUri(uri)), edits })
  }
  for (const change of edit.documentChanges ?? []) {
    if ('textDocument' in change) {
      steps.push({ kind: 'edit', path: resolve(context.cwd, filePathFromUri(change.textDocument.uri)), edits: change.edits })
    } else if (change.kind === 'create') {
      steps.push({ kind: 'create', path: resolve(context.cwd, filePathFromUri(change.uri)), options: change.options })
    } else if (change.kind === 'rename') {
      steps.push({ kind: 'rename', oldPath: resolve(context.cwd, filePathFromUri(change.oldUri)), newPath: resolve(context.cwd, filePathFromUri(change.newUri)), options: change.options })
    } else {
      steps.push({ kind: 'delete', path: resolve(context.cwd, filePathFromUri(change.uri)), options: change.options })
    }
  }

  // First pass validates all operations and builds the final virtual workspace.
  // No filesystem mutation happens until this pass completes.
  const existence = new Map<string, boolean>()
  const original = new Map<string, string>()
  const virtual = new Map<string, string>()
  const ignored = new Set<WorkspaceStep>()
  const resourceContent = new Map<WorkspaceStep, string | undefined>()
  const load = async (filePath: string): Promise<boolean> => {
    if (existence.has(filePath)) return existence.get(filePath)!
    const present = await exists(filePath)
    existence.set(filePath, present)
    if (present) {
      const content = await readFile(filePath, 'utf8')
      original.set(filePath, content)
      virtual.set(filePath, content)
    }
    return present
  }

  for (const step of steps) {
    if (step.kind === 'edit') {
      assertWriteAllowed(step.path, context)
      if (!(await load(step.path))) throw new Error(`LSP edit target does not exist: ${step.path}`)
      virtual.set(step.path, applyTextEdits(virtual.get(step.path)!, step.edits))
    } else if (step.kind === 'create') {
      assertWriteAllowed(step.path, context)
      const present = await load(step.path)
      if (present && step.options?.ignoreIfExists) {
        ignored.add(step)
        continue
      }
      if (present && !step.options?.overwrite) throw new Error(`LSP create target already exists: ${step.path}`)
      existence.set(step.path, true)
      virtual.set(step.path, '')
      if (!original.has(step.path)) original.set(step.path, '')
    } else if (step.kind === 'rename') {
      assertWriteAllowed(step.oldPath, context)
      assertWriteAllowed(step.newPath, context)
      if (!(await load(step.oldPath))) throw new Error(`LSP rename source does not exist: ${step.oldPath}`)
      const targetPresent = await load(step.newPath)
      if (targetPresent && step.options?.ignoreIfExists) {
        ignored.add(step)
        continue
      }
      if (targetPresent && !step.options?.overwrite) throw new Error(`LSP rename target already exists: ${step.newPath}`)
      resourceContent.set(step, virtual.get(step.oldPath))
      existence.set(step.oldPath, false)
      existence.set(step.newPath, true)
      virtual.set(step.newPath, virtual.get(step.oldPath)!)
      virtual.delete(step.oldPath)
      original.set(step.newPath, original.get(step.oldPath)!)
      original.delete(step.oldPath)
    } else {
      assertWriteAllowed(step.path, context)
      if (!(await load(step.path))) {
        if (step.options?.ignoreIfNotExists) {
          ignored.add(step)
          continue
        }
        throw new Error(`LSP delete target does not exist: ${step.path}`)
      }
      resourceContent.set(step, virtual.get(step.path))
      existence.set(step.path, false)
      virtual.delete(step.path)
    }
  }

  const changedFiles: string[] = []
  const changed = new Set<string>()
  const markChanged = (filePath: string) => {
    if (!changed.has(filePath)) {
      changed.add(filePath)
      changedFiles.push(filePath)
    }
  }
  const flush = async (filePath: string) => {
    if (!existence.get(filePath) || !virtual.has(filePath)) return
    const content = virtual.get(filePath)!
    if (original.get(filePath) !== content || !(await exists(filePath))) {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFileAtomic(filePath, content)
      await notifyLspFileChanged(filePath)
      markChanged(filePath)
    }
  }

  // Apply resource operations in documentChanges order. Text edits are
  // flushed immediately before a resource operation that depends on them.
  for (const step of steps) {
    if (ignored.has(step) || step.kind === 'edit') continue
    if (step.kind === 'create') {
      if (await exists(step.path) && step.options?.overwrite) await rm(step.path, { recursive: true, force: true })
      await mkdir(dirname(step.path), { recursive: true })
      await writeFileAtomic(step.path, '')
      markChanged(step.path)
    } else if (step.kind === 'rename') {
      const renamedContent = resourceContent.get(step)
      if (renamedContent !== undefined && original.get(step.newPath) !== renamedContent) {
        await writeFileAtomic(step.oldPath, renamedContent)
        await notifyLspFileChanged(step.oldPath)
      }
      if (await exists(step.newPath) && step.options?.overwrite) await rm(step.newPath, { recursive: true, force: true })
      await mkdir(dirname(step.newPath), { recursive: true })
      await notifyLspFileClosed(step.oldPath)
      await rename(step.oldPath, step.newPath)
      await notifyLspFileChanged(step.newPath)
      markChanged(`${step.oldPath} -> ${step.newPath}`)
    } else {
      const deletedContent = resourceContent.get(step)
      if (deletedContent !== undefined && original.get(step.path) !== deletedContent) {
        await writeFileAtomic(step.path, deletedContent)
        await notifyLspFileChanged(step.path)
      }
      await notifyLspFileClosed(step.path)
      await rm(step.path, { recursive: step.options?.recursive ?? false, force: true })
      markChanged(step.path)
    }
  }
  for (const filePath of virtual.keys()) await flush(filePath)
  return changedFiles
}

function assertWriteAllowed(filePath: string, context: ToolContext): void {
  const sandboxError = ensurePathAllowed(filePath, 'write', context.sandbox, context.additionalDirectories)
  if (sandboxError) throw new Error(sandboxError)
}

async function exists(filePath: string): Promise<boolean> {
  try { await stat(filePath); return true } catch { return false }
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.${crypto.randomUUID()}.lsp.tmp`)
  try {
    await writeFile(tempPath, content, 'utf8')
    await rename(tempPath, filePath)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}
