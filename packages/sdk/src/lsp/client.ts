import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

export interface LspPosition {
  line: number
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface LspLocation {
  uri: string
  range: LspRange
}

export interface LspLocationLink {
  targetUri: string
  targetRange: LspRange
  targetSelectionRange?: LspRange
}

export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>
  documentChanges?: Array<LspTextDocumentEdit | LspCreateFile | LspRenameFile | LspDeleteFile>
  changeAnnotations?: Record<string, { label: string; needsConfirmation?: boolean; description?: string }>
}

export interface LspTextDocumentEdit {
  textDocument: { uri: string; version?: number | null }
  edits: LspTextEdit[]
}

export interface LspCreateFile {
  kind: 'create'
  uri: string
  options?: { overwrite?: boolean; ignoreIfExists?: boolean }
}

export interface LspRenameFile {
  kind: 'rename'
  oldUri: string
  newUri: string
  options?: { overwrite?: boolean; ignoreIfExists?: boolean }
}

export interface LspDeleteFile {
  kind: 'delete'
  uri: string
  options?: { recursive?: boolean; ignoreIfNotExists?: boolean }
}

export interface LspDiagnostic {
  range: LspRange
  severity?: 1 | 2 | 3 | 4
  code?: string | number
  source?: string
  message: string
  relatedInformation?: Array<{ location: LspLocation; message: string }>
}

export interface LspServerCapabilities {
  [key: string]: unknown
  diagnosticProvider?: boolean | Record<string, unknown>
  renameProvider?: boolean | Record<string, unknown>
  codeActionProvider?: boolean | Record<string, unknown>
}

export interface LspTextEdit {
  range: LspRange
  newText: string
}

export interface LspServerConfig {
  name?: string
  command?: string
  args?: string[]
  cwd?: string
  fileTypes?: string[]
  rootMarkers?: string[]
  initOptions?: Record<string, unknown>
  settings?: Record<string, unknown>
  requestTimeoutMs?: number
}

export type ResolvedLspServerConfig = Omit<LspServerConfig, 'command' | 'args'> & {
  command: string
  args: string[]
  cwd?: string
}

interface JsonRpcResponse {
  id: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

const clients = new Map<string, Promise<LspClient>>()
const clientLocks = new Map<string, Promise<void>>()
let idleTimeoutMs: number | null = null
let idleChecker: ReturnType<typeof setInterval> | undefined

export type LspClientState = 'initializing' | 'ready' | 'failed' | 'restarting' | 'disposed'

export interface LspAggregatedDiagnostic extends LspDiagnostic {
  server: string
}

export interface LspWatchedFileChange {
  uri: string
  type: 1 | 2 | 3
}

export interface LspServerStatus {
  server: string
  status: 'ready' | 'error'
  state: LspClientState
  cwd: string
  capabilities: LspServerCapabilities
  openFiles: number
  diagnosticsVersion: number
  lastActivity: string
}

export function setLspIdleTimeout(timeoutMs: number | null | undefined): void {
  idleTimeoutMs = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : null
  if (idleChecker) clearInterval(idleChecker)
  idleChecker = undefined
  if (idleTimeoutMs !== null) {
    idleChecker = setInterval(() => {
      void Promise.all([...clients.entries()].map(async ([key, pending]) => {
        const client = await pending.catch(() => undefined)
        if (!client || !client.isIdle(idleTimeoutMs!)) return
        clients.delete(key)
        await client.dispose()
      }))
    }, 60_000)
    idleChecker.unref?.()
  }
}

export function encodeLspMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, 'ascii'),
    body,
  ])
}

export function parseLspMessages(input: Buffer<ArrayBufferLike>, previous: Buffer<ArrayBufferLike> = Buffer.alloc(0)): {
  messages: unknown[]
  rest: Buffer<ArrayBufferLike>
} {
  let buffer = Buffer.concat([previous, input])
  const messages: unknown[] = []

  while (true) {
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'))
    if (headerEnd < 0) break
    const headerText = buffer.subarray(0, headerEnd).toString('ascii')
    const headers = headerText.split('\r\n')
    const lengthHeader = headers.find((header) => /^content-length:/i.test(header))
    if (!lengthHeader) {
      const nextHeader = buffer.toString('ascii').toLowerCase().indexOf('content-length:')
      if (nextHeader > 0) {
        buffer = buffer.subarray(nextHeader)
        continue
      }
      throw new Error('Invalid LSP header: missing Content-Length')
    }
    const length = Number(lengthHeader?.split(':', 2)[1]?.trim())
    if (!Number.isInteger(length) || length < 0) {
      throw new Error('Invalid LSP Content-Length header')
    }
    const bodyStart = headerEnd + 4
    if (buffer.byteLength < bodyStart + length) break
    const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8')
    messages.push(JSON.parse(body))
    buffer = buffer.subarray(bodyStart + length)
  }

  return { messages, rest: buffer }
}

export function applyTextEdits(content: string, edits: LspTextEdit[]): string {
  const positioned = edits.map((edit, index) => ({
    ...edit,
    index,
    start: offsetAt(content, edit.range.start),
    end: offsetAt(content, edit.range.end),
  }))
  positioned.sort((left, right) => right.start - left.start || right.end - left.end || right.index - left.index)
  const unique = positioned.filter((edit, index, all) => {
    const previous = all[index - 1]
    return !previous || previous.start !== edit.start || previous.end !== edit.end || previous.newText !== edit.newText || edit.start === edit.end
  })
  for (let index = 0; index < unique.length - 1; index += 1) {
    const current = unique[index]!
    const next = unique[index + 1]!
    if (current.start < next.end) {
      throw new Error('LSP returned overlapping text edits')
    }
  }
  let result = content
  for (const edit of unique) {
    result = `${result.slice(0, edit.start)}${edit.newText}${result.slice(edit.end)}`
  }
  return result
}

function offsetAt(content: string, position: LspPosition): number {
  if (position.line < 0 || position.character < 0) throw new Error('Invalid LSP position')
  let line = 0
  let offset = 0
  while (line < position.line) {
    const newline = content.indexOf('\n', offset)
    if (newline < 0) throw new Error('LSP position is outside the document')
    offset = newline + 1
    line += 1
  }
  const lineEnd = content.indexOf('\n', offset)
  const max = lineEnd < 0 ? content.length : lineEnd
  return Math.min(offset + position.character, max)
}

function fileUri(filePath: string): string {
  return pathToFileURL(resolve(filePath)).toString()
}

export function filePathFromUri(uri: string): string {
  if (!uri.startsWith('file://')) throw new Error(`Unsupported LSP URI: ${uri}`)
  return fileURLToPath(uri)
}

function serverKey(cwd: string, server: ResolvedLspServerConfig): string {
  return `${resolve(cwd)}\0${server.name ?? 'default'}\0${resolve(server.cwd ?? cwd)}\0${server.command}\0${server.args.join('\0')}`
}

export function resolveLspServerConfig(toolConfig?: Record<string, unknown>): ResolvedLspServerConfig {
  const configured = toolConfig?.lsp
  const value = configured && typeof configured === 'object' && !Array.isArray(configured)
    ? configured as Record<string, unknown>
    : {}
  const command = typeof value.command === 'string' && value.command.trim()
    ? value.command.trim()
    : process.env.LUME_LSP_COMMAND?.trim() || 'typescript-language-server'
  const args = Array.isArray(value.args)
    ? value.args.filter((item): item is string => typeof item === 'string')
    : process.env.LUME_LSP_ARGS?.trim()
      ? process.env.LUME_LSP_ARGS.trim().split(/\s+/)
      : ['--stdio']
  const configuredCwd = typeof value.cwd === 'string' && value.cwd.trim() ? value.cwd : undefined
  return { name: 'default', command, args, ...(configuredCwd ? { cwd: resolve(configuredCwd) } : {}) }
}

export async function resolveLspServerConfigsForFile(cwd: string, toolConfig?: Record<string, unknown>, filePath?: string): Promise<ResolvedLspServerConfig[]> {
  const configured = toolConfig?.lsp
  const lsp = configured && typeof configured === 'object' && !Array.isArray(configured)
    ? configured as Record<string, unknown>
    : undefined
  if (lsp?.command) {
    const direct = normalizeServerConfig('default', lsp, cwd)
    if (direct && (!filePath || (supportsFile(direct, filePath) && hasRootMarker(filePath, direct.rootMarkers ?? [])))) return [direct]
    if (filePath) throw new Error(`No configured LSP server supports ${basename(filePath)}`)
  }
  const servers = lsp?.servers && typeof lsp.servers === 'object' && !Array.isArray(lsp.servers)
    ? lsp.servers as Record<string, unknown>
    : lsp
      ? undefined
      : await readProjectLspServers(cwd)
  if (servers) {
    const candidates = Object.entries(servers)
      .map(([name, value]) => normalizeServerConfig(name, value, cwd))
      .filter((value): value is ResolvedLspServerConfig => Boolean(value))
      .filter((value) => !filePath || (supportsFile(value, filePath) && hasRootMarker(filePath, value.rootMarkers ?? [])))
    if (candidates.length > 0) return candidates
    if (filePath) throw new Error(`No configured LSP server supports ${basename(filePath)}`)
  }
  return [{ ...resolveLspServerConfig(toolConfig), name: 'default' }]
}

async function readProjectLspServers(cwd: string): Promise<Record<string, unknown> | undefined> {
  let directory = resolve(cwd)
  while (true) {
    for (const filename of ['lsp.json', '.lsp.json']) {
      try {
        const parsed = JSON.parse(await readFile(resolve(directory, filename), 'utf8')) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
        const value = parsed as Record<string, unknown>
        if (value.servers && typeof value.servers === 'object' && !Array.isArray(value.servers)) return value.servers as Record<string, unknown>
        return value
      } catch {
        // A project-local config is optional; continue with the parent directory.
      }
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

function normalizeServerConfig(name: string, value: unknown, workspaceRoot: string): ResolvedLspServerConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const command = typeof record.command === 'string' && record.command.trim() ? record.command.trim() : undefined
  if (!command) return undefined
  const args = Array.isArray(record.args) ? record.args.filter((item): item is string => typeof item === 'string') : ['--stdio']
  return {
    name,
    command,
    args,
    fileTypes: Array.isArray(record.fileTypes) ? record.fileTypes.filter((item): item is string => typeof item === 'string') : [],
    rootMarkers: Array.isArray(record.rootMarkers) ? record.rootMarkers.filter((item): item is string => typeof item === 'string') : [],
    initOptions: record.initOptions && typeof record.initOptions === 'object' && !Array.isArray(record.initOptions) ? record.initOptions as Record<string, unknown> : {},
    settings: record.settings && typeof record.settings === 'object' && !Array.isArray(record.settings) ? record.settings as Record<string, unknown> : {},
    requestTimeoutMs: typeof record.requestTimeoutMs === 'number' && record.requestTimeoutMs > 0 ? record.requestTimeoutMs : 15_000,
    ...(typeof record.cwd === 'string' && record.cwd.trim() ? { cwd: resolve(workspaceRoot, record.cwd) } : {}),
  }
}

function supportsFile(server: ResolvedLspServerConfig, filePath: string): boolean {
  const fileTypes = server.fileTypes ?? []
  if (fileTypes.length === 0) return true
  const extension = filePath.toLowerCase().slice(filePath.lastIndexOf('.'))
  const name = basename(filePath).toLowerCase()
  return fileTypes.some((type) => {
    const normalized = type.toLowerCase()
    return normalized === extension || normalized === name || normalized.replace(/^\./, '') === extension.slice(1)
  })
}

function hasRootMarker(filePath: string, markers: string[]): boolean {
  if (markers.length === 0) return true
  let directory = dirname(resolve(filePath))
  while (true) {
    if (markers.some((marker) => existsSync(resolve(directory, marker)))) return true
    const parent = dirname(directory)
    if (parent === directory) return false
    directory = parent
  }
}

function findWorkspaceRoot(cwd: string, filePath: string | undefined, markers: string[]): string {
  if (!filePath || markers.length === 0) return resolve(cwd)
  let directory = dirname(resolve(filePath))
  while (true) {
    if (markers.some((marker) => existsSync(resolve(directory, marker)))) return directory
    const parent = dirname(directory)
    if (parent === directory) return resolve(cwd)
    directory = parent
  }
}

export async function getLspClientsForFile(cwd: string, config?: Record<string, unknown>, filePath?: string): Promise<LspClient[]> {
  const servers = await resolveLspServerConfigsForFile(cwd, config, filePath)
  const results = await Promise.all(servers.map(async (server) => {
    const workspaceRoot = findWorkspaceRoot(cwd, filePath, server.rootMarkers ?? [])
    const runtimeServer = server.cwd ? server : { ...server, cwd: workspaceRoot }
    const key = serverKey(workspaceRoot, runtimeServer)
    let client = clients.get(key)
    if (!client) {
      client = LspClient.start(workspaceRoot, runtimeServer, () => {
        if (clients.get(key) === client) clients.delete(key)
      })
      clients.set(key, client)
      client.catch(() => clients.delete(key))
    }
    try {
      return await client
    } catch {
      return undefined
    }
  }))
  const ready = results.filter((client): client is LspClient => Boolean(client))
  if (ready.length === 0) throw new Error(`Unable to start any configured LSP server for ${filePath ?? cwd}`)
  return ready
}

export async function getLspClient(cwd: string, config?: Record<string, unknown>, filePath?: string): Promise<LspClient> {
  const client = (await getLspClientsForFile(cwd, config, filePath))[0]
  if (!client) throw new Error('No LSP server configured')
  return client
}

export async function requestLspClients<T>(
  clientsForRequest: LspClient[],
  method: string,
  params: unknown,
  timeoutMs = 15_000,
  signal?: AbortSignal,
): Promise<Array<{ server: string; result: T }>> {
  const results = await Promise.all(clientsForRequest.map(async (client) => {
    try {
      return { server: client.serverName, result: await client.request<T>(method, params, timeoutMs, signal) as T }
    } catch (error) {
      if (signal?.aborted) throw error
      return undefined
    }
  }))
  return results.filter((value): value is { server: string; result: T } => Boolean(value))
}

export async function collectLspDiagnostics(
  clientsForRequest: LspClient[],
  filePath: string,
  timeoutMs = 3_000,
  signal?: AbortSignal,
): Promise<LspAggregatedDiagnostic[]> {
  const results = await Promise.all(clientsForRequest.map(async (client) => {
    try {
      const diagnostics = await client.waitForDiagnostics(filePath, timeoutMs, signal)
      return diagnostics.map((diagnostic) => ({ ...diagnostic, server: client.serverName }))
    } catch (error) {
      if (signal?.aborted) throw error
      return []
    }
  }))
  const seen = new Set<string>()
  return results.flat().filter((diagnostic) => {
    const key = [diagnostic.server, diagnostic.range.start.line, diagnostic.range.start.character, diagnostic.range.end.line, diagnostic.range.end.character, diagnostic.severity ?? '', diagnostic.code ?? '', diagnostic.message].join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function notifyLspFileChanged(filePath: string): Promise<void> {
  const absolutePath = resolve(filePath)
  await Promise.all([...clients.values()].map(async (pending) => {
    const client = await pending.catch(() => undefined)
    if (!client || !client.ownsPath(absolutePath)) return
    try {
      await client.syncFile(absolutePath)
      await client.notifySaved(absolutePath)
    } catch {
      // File writes must remain successful even when a language server is wedged.
    }
  }))
}

export async function notifyLspFileClosed(filePath: string): Promise<void> {
  const absolutePath = resolve(filePath)
  await Promise.all([...clients.values()].map(async (pending) => {
    const client = await pending.catch(() => undefined)
    if (!client || !client.ownsPath(absolutePath)) return
    await client.closeFile(absolutePath).catch(() => undefined)
  }))
}

export async function notifyLspWatchedFiles(changes: LspWatchedFileChange[]): Promise<void> {
  await Promise.all([...clients.values()].map(async (pending) => {
    const client = await pending.catch(() => undefined)
    if (!client) return
    await client.notifyWatchedFiles(changes).catch(() => undefined)
  }))
}

export async function shutdownLspClients(cwd?: string): Promise<void> {
  const normalizedCwd = cwd ? resolve(cwd) : undefined
  const entries = [...clients.entries()]
  await Promise.all(entries.map(async ([key, pending]) => {
    const client = await pending.catch(() => undefined)
    if (!client || (normalizedCwd && resolve(client.cwd) !== normalizedCwd)) return
    clients.delete(key)
    await client.dispose()
  }))
}

export class LspClient {
  private constructor(
    readonly cwd: string,
    private readonly server: ResolvedLspServerConfig,
    private readonly process: ChildProcessWithoutNullStreams,
    private readonly onDead: () => void,
  ) {
    this.exited = new Promise((resolve) => this.process.once('exit', () => resolve()))
    this.process.stdout.on('data', (chunk: Buffer) => this.onOutput(chunk))
    this.process.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-4_000)
    })
    this.process.on('error', (error) => this.fail(error))
    this.process.on('exit', (code, signal) => this.fail(new Error(
      `LSP server exited (${code ?? signal ?? 'unknown'})${this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : ''}`,
    )))
  }

  private nextId = 1
  private outputBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private readonly pending = new Map<number | string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private readonly documents = new Map<string, { version: number; content: string }>()
  private readonly diagnostics = new Map<string, { diagnostics: LspDiagnostic[]; version?: number | null }>()
  private readonly dynamicCapabilities = new Map<string, string>()
  private writeQueue = Promise.resolve()
  private diagnosticsVersion = 0
  private lastActivity = Date.now()
  private serverCapabilities: LspServerCapabilities = {}
  private stderrTail = ''
  private dead = false
  private readonly exited: Promise<void>
  private initialized = false
  private disposed = false

  get serverName(): string { return this.server.name ?? 'default' }

  get state(): LspClientState {
    if (this.disposed) return 'disposed'
    if (this.dead) return 'failed'
    if (!this.initialized) return 'initializing'
    return 'ready'
  }

  static async start(cwd: string, server: ResolvedLspServerConfig, onDead = () => undefined): Promise<LspClient> {
    const child = spawn(server.command, server.args, {
      cwd: server.cwd ?? cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const client = new LspClient(cwd, server, child, onDead)
    try {
      await client.initialize()
    } catch (error) {
      child.kill()
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Unable to start LSP server "${server.command}": ${detail}`)
    }
    return client
  }

  ownsPath(filePath: string): boolean {
    const root = resolve(this.cwd)
    const absolute = resolve(filePath)
    return absolute === root || absolute.startsWith(`${root}/`) || absolute.startsWith(`${root}\\`)
  }

  isIdle(timeoutMs: number): boolean {
    return Date.now() - this.lastActivity >= timeoutMs
  }

  async syncFile(filePath: string): Promise<void> {
    if (!this.ownsPath(filePath)) return
    const content = await readFile(filePath, 'utf8')
    const uri = fileUri(filePath)
    await this.withDocumentLock(uri, async () => {
      this.diagnostics.delete(uri)
      const current = this.documents.get(uri)
      if (!current) {
        this.documents.set(uri, { version: 1, content })
        await this.notify('textDocument/didOpen', {
          textDocument: { uri, languageId: languageIdForPath(filePath), version: 1, text: content },
        })
        return
      }
      const version = current.version + 1
      this.documents.set(uri, { version, content })
      await this.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      })
    })
  }

  async notifySaved(filePath: string): Promise<void> {
    const uri = fileUri(filePath)
    if (!this.documents.has(uri)) return
    await this.notify('textDocument/didSave', { textDocument: { uri } })
  }

  async closeFile(filePath: string): Promise<void> {
    const uri = fileUri(filePath)
    if (!this.documents.has(uri)) return
    await this.notify('textDocument/didClose', { textDocument: { uri } })
    this.documents.delete(uri)
    this.diagnostics.delete(uri)
  }

  async notifyWatchedFiles(changes: LspWatchedFileChange[]): Promise<void> {
    await this.notify('workspace/didChangeWatchedFiles', { changes })
  }

  async request<T>(method: string, params: unknown, timeoutMs = 15_000, signal?: AbortSignal): Promise<T> {
    const id = this.nextId++
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      void this.send({ jsonrpc: '2.0', id, method, params }).catch(reject)
    })
    let timeout: ReturnType<typeof setTimeout> | undefined
    let abortHandler: (() => void) | undefined
    try {
      return await Promise.race([
        result,
        new Promise<T>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`LSP request timed out: ${method}`)), timeoutMs)
          if (signal) {
            abortHandler = () => reject(signal.reason instanceof Error ? signal.reason : new Error('LSP request aborted'))
            if (signal.aborted) abortHandler()
            else signal.addEventListener('abort', abortHandler, { once: true })
          }
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
      if (abortHandler && signal) signal.removeEventListener('abort', abortHandler)
      this.pending.delete(id)
    }
  }

  getDiagnostics(filePath: string): LspDiagnostic[] {
    return this.diagnostics.get(fileUri(filePath))?.diagnostics ?? []
  }

  async waitForDiagnostics(filePath: string, timeoutMs = 3_000, signal?: AbortSignal): Promise<LspDiagnostic[]> {
    const uri = fileUri(filePath)
    const alreadyPublished = this.diagnostics.get(uri)
    if (alreadyPublished) return alreadyPublished.diagnostics
    if (this.supportsDocumentDiagnostics()) {
      try {
        const pulled = await this.request<{ items?: LspDiagnostic[] }>('textDocument/diagnostic', {
          textDocument: { uri },
        }, timeoutMs, signal)
        const diagnostics = pulled?.items ?? []
        this.diagnostics.set(uri, { diagnostics })
        this.diagnosticsVersion += 1
        return diagnostics
      } catch {
        // Fall back to publishDiagnostics for older servers.
      }
    }
    const startedVersion = this.diagnosticsVersion
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('LSP diagnostics aborted')
      const published = this.diagnostics.get(uri)
      if (published && this.diagnosticsVersion > startedVersion) return published.diagnostics
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return this.getDiagnostics(filePath)
  }

  getStatus(): LspServerStatus {
    return {
      server: this.serverName,
      status: this.process.exitCode === null ? 'ready' : 'error',
      state: this.state,
      cwd: this.cwd,
      capabilities: this.serverCapabilities,
      openFiles: this.documents.size,
      diagnosticsVersion: this.diagnosticsVersion,
      lastActivity: new Date(this.lastActivity).toISOString(),
    }
  }

  supportsDocumentDiagnostics(): boolean {
    return Boolean(this.serverCapabilities.diagnosticProvider || [...this.dynamicCapabilities.values()].includes('textDocument/diagnostic'))
  }

  async reload(): Promise<void> {
    const files = [...this.documents.entries()]
    for (const [uri, document] of files) {
      await this.notify('textDocument/didChange', {
        textDocument: { uri, version: document.version + 1 },
        contentChanges: [{ text: document.content }],
      })
    }
    await this.notify('workspace/didChangeConfiguration', { settings: {} })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    try {
      // Do not wait for a graceful shutdown handshake here: a language server
      // that stopped draining stdin must not keep workspace teardown blocked.
      if (this.initialized && this.process.exitCode === null) void this.notify('exit', null).catch(() => undefined)
    } catch {
      // The process is still forcibly terminated below.
    } finally {
      if (this.process.exitCode === null) this.process.kill()
      this.fail(new Error('LSP client disposed'))
      await Promise.race([this.exited, new Promise((resolve) => setTimeout(resolve, 250))])
    }
  }

  private async initialize(): Promise<void> {
    const result = await this.request<LspServerCapabilities & { capabilities?: LspServerCapabilities }>('initialize', {
      processId: process.pid,
      rootPath: this.cwd,
      rootUri: fileUri(this.cwd),
      capabilities: {
        workspace: { workspaceFolders: true, applyEdit: true },
        textDocument: {
          synchronization: { dynamicRegistration: false, willSave: false, didSave: false, willSaveWaitUntil: false },
          definition: { linkSupport: true },
          implementation: { linkSupport: true },
          references: {},
          hover: { contentFormat: ['markdown', 'plaintext'] },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          rename: { prepareSupport: true },
          typeDefinition: { linkSupport: true },
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: ['quickfix', 'refactor', 'source', 'source.organizeImports', 'source.fixAll'],
              },
            },
            resolveSupport: { properties: ['edit'] },
          },
          formatting: {},
          rangeFormatting: {},
          callHierarchy: { dynamicRegistration: false },
          publishDiagnostics: {},
        },
      },
      workspaceFolders: [{ uri: fileUri(this.cwd), name: resolve(this.cwd).split(/[\\/]/).pop() || 'workspace' }],
      initializationOptions: this.server.initOptions ?? {},
    }, this.server.requestTimeoutMs ?? 15_000)
    this.initialized = true
    this.serverCapabilities = result?.capabilities ?? {}
    await this.notify('initialized', {})
    await this.notify('workspace/didChangeConfiguration', { settings: this.server.settings ?? {} })
  }

  private async notify(method: string, params: unknown): Promise<void> {
    if (!this.initialized && method !== 'initialized') return
    await this.send({ jsonrpc: '2.0', method, params })
  }

  private send(message: unknown): Promise<void> {
    this.lastActivity = Date.now()
    const write = this.writeQueue.catch(() => undefined).then(() => {
      if (!this.process.stdin.writable) throw new Error('LSP server stdin is not writable')
      return new Promise<void>((resolve, reject) => {
        this.process.stdin.write(encodeLspMessage(message), (error) => error ? reject(error) : resolve())
      })
    })
    this.writeQueue = write.catch(() => undefined)
    return write
  }

  private onOutput(chunk: Buffer): void {
    try {
      const parsed = parseLspMessages(chunk, this.outputBuffer)
      this.outputBuffer = parsed.rest
      for (const message of parsed.messages) this.onMessage(message)
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private onMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return
    const value = message as Record<string, unknown>
    if (typeof value.method === 'string') {
      if (typeof value.id === 'number' || typeof value.id === 'string') {
        void this.handleServerRequest(value.method, value.id, value.params)
        return
      }
      if (value.method === 'textDocument/publishDiagnostics') {
        const params = value.params as { uri?: string; diagnostics?: LspDiagnostic[]; version?: number | null } | undefined
        if (params?.uri) {
          this.diagnostics.set(params.uri, { diagnostics: params.diagnostics ?? [], version: params.version })
          this.diagnosticsVersion += 1
        }
      }
      return
    }
    if (typeof value.id !== 'number' && typeof value.id !== 'string') return
    const responseId = value.id
    const response = value as unknown as JsonRpcResponse
    const pending = this.pending.get(responseId)
    if (!pending) return
    this.pending.delete(responseId)
    if (response.error) pending.reject(new Error(`${response.error.message} (${response.error.code})`))
    else pending.resolve(response.result)
  }

  private async handleServerRequest(method: string, id: number | string, params: unknown): Promise<void> {
    if (method === 'workspace/workspaceFolders') {
      await this.send({ jsonrpc: '2.0', id, result: [{ uri: fileUri(this.cwd), name: resolve(this.cwd).split(/[\\/]/).pop() || 'workspace' }] })
      return
    }
    if (method === 'workspace/configuration') {
      const items = Array.isArray((params as { items?: unknown[] } | undefined)?.items)
        ? (params as { items: unknown[] }).items.map(() => ({}))
        : []
      await this.send({ jsonrpc: '2.0', id, result: items })
      return
    }
    if (method === 'client/registerCapability') {
      const registrations = (params as { registrations?: Array<{ id?: string; method?: string }> } | undefined)?.registrations ?? []
      for (const registration of registrations) {
        if (registration.id && registration.method) this.dynamicCapabilities.set(registration.id, registration.method)
      }
      await this.send({ jsonrpc: '2.0', id, result: null })
      return
    }
    if (method === 'client/unregisterCapability') {
      const unregisterations = (params as { unregisterations?: Array<{ id?: string }>; unregistrations?: Array<{ id?: string }> } | undefined)
      const registrations = unregisterations?.unregisterations ?? unregisterations?.unregistrations ?? []
      for (const registration of registrations) if (registration.id) this.dynamicCapabilities.delete(registration.id)
      await this.send({ jsonrpc: '2.0', id, result: null })
      return
    }
    if (method === 'window/showMessageRequest') {
      await this.send({ jsonrpc: '2.0', id, result: null })
      return
    }
    if (method === 'window/showDocument') {
      await this.send({ jsonrpc: '2.0', id, result: { success: false } })
      return
    }
    if (method === 'workspace/applyEdit') {
      await this.send({
        jsonrpc: '2.0',
        id,
        result: { applied: false, failureReason: 'Headless Lume applies WorkspaceEdit through the LSP tool with explicit permission.' },
      })
      return
    }
    if (method === 'window/workDoneProgress/create' || method.startsWith('workspace/') || method.startsWith('$/')) {
      await this.send({ jsonrpc: '2.0', id, result: null })
      return
    }
    await this.send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
  }

  private async withDocumentLock<T>(uri: string, operation: () => Promise<T>): Promise<T> {
    const existing = clientLocks.get(uri)
    if (existing) await existing
    let release!: () => void
    const lock = new Promise<void>((resolve) => { release = resolve })
    clientLocks.set(uri, lock)
    try { return await operation() } finally {
      release()
      if (clientLocks.get(uri) === lock) clientLocks.delete(uri)
    }
  }

  private fail(error: Error): void {
    if (this.dead) return
    this.dead = true
    for (const { reject } of this.pending.values()) reject(error)
    this.pending.clear()
    this.initialized = false
    this.onDead()
  }
}

export function languageIdForPath(filePath: string): string {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.tsx')) return 'typescriptreact'
  if (lower.endsWith('.jsx')) return 'javascriptreact'
  if (lower.endsWith('.ts')) return 'typescript'
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript'
  if (lower.endsWith('.json')) return 'json'
  return 'plaintext'
}
