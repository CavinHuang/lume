import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  LspDiagnosticBatch,
  LspWritethroughResult,
  ToolContext,
} from '../types.js'
import {
  applyTextEdits,
  getLspClientsForFile,
  type LspAggregatedDiagnostic,
  type LspClient,
  type LspTextEdit,
} from './client.js'
import { collectLspAdapterDiagnostics } from './adapters.js'

interface PreparedLspWritethrough {
  content: string
  commit(): Promise<LspWritethroughResult>
}

export interface PreparedLspWritethroughBatch {
  contents: Map<string, string>
  commit(): Promise<LspWritethroughResult>
}

const mutationVersions = new Map<string, number>()
const diagnosticLedger = new Map<string, Set<string>>()
const INLINE_DIAGNOSTICS_TIMEOUT_MS = 500
const DELAYED_DIAGNOSTICS_TIMEOUT_MS = 12_000

export async function prepareLspWritethrough(input: {
  filePath: string
  content: string
  context: ToolContext
  existedBefore: boolean
}): Promise<PreparedLspWritethrough> {
  const filePath = resolve(input.filePath)
  const lsp = lspOptions(input.context)
  if (lsp.enabled === false) return noLsp(input.content)

  const clients = await withTimeout(
    getLspClientsForFile(input.context.cwd, input.context.toolConfig, filePath),
    lsp.warmupTimeoutMs,
  ).catch(() => [] as LspClient[])

  const beforeSequence = new Map(clients.map((client) => [client.serverName, client.getDiagnosticsSequence()]))
  let content = input.content
  let formatted = false
  const versions = new Map<string, number>()

  for (const client of clients) {
    const version = await client.syncContent(filePath, content).catch(() => 0)
    versions.set(client.serverName, version)
  }

  if (lsp.formatOnWrite) {
    const formatter = clients.find((client) => {
      const capabilities = client.getStatus().capabilities
      return Boolean(capabilities.documentFormattingProvider || capabilities.formattingProvider)
    })
    if (formatter) {
      try {
        const edits = await formatter.request<LspTextEdit[]>('textDocument/formatting', {
          textDocument: { uri: fileUri(filePath) },
          options: inferFormattingOptions(content),
        }, lsp.requestTimeoutMs, input.context.abortSignal)
        const formattedContent = applyTextEdits(content, edits ?? [])
        if (formattedContent !== content) {
          content = formattedContent
          formatted = true
          for (const client of clients) {
            const version = await client.syncContent(filePath, content).catch(() => versions.get(client.serverName) ?? 0)
            versions.set(client.serverName, version)
          }
        }
      } catch {
        // Formatting is advisory and must never invalidate a legal file write.
      }
    }
  }

  const mutationKey = `${input.context.sessionId ?? input.context.runId ?? 'global'}\0${filePath}`
  const mutationVersion = (mutationVersions.get(mutationKey) ?? 0) + 1
  mutationVersions.set(mutationKey, mutationVersion)
  const expectedSha = sha256(content)

  return {
    content,
    async commit() {
      await Promise.all(clients.map(async (client) => {
        await client.notifyWatchedFiles([{ uri: fileUri(filePath), type: input.existedBefore ? 2 : 1 }]).catch(() => undefined)
        await client.notifySaved(filePath).catch(() => undefined)
      }))
      if (!lsp.diagnosticsOnWrite) {
        return {
          servers: clients.map((client) => client.serverName),
          formatted,
          diagnosticsDelayed: false,
          mutationVersion,
        }
      }

      const pending = Promise.all([
        collectFreshDiagnostics(
          clients,
          filePath,
          versions,
          beforeSequence,
          DELAYED_DIAGNOSTICS_TIMEOUT_MS,
          input.context.abortSignal,
        ),
        withTimeout(
          collectLspAdapterDiagnostics(filePath, input.context),
          DELAYED_DIAGNOSTICS_TIMEOUT_MS,
        ).catch(() => undefined),
      ]).then(([diagnostics, adapter]) => summarizeDiagnostics([
        ...diagnostics,
        ...(adapter?.diagnostics.items.map((diagnostic) => ({
          ...diagnostic,
          server: diagnostic.server ?? adapter.server,
        })) ?? []),
      ], input.context, filePath))
      const inline = await withTimeout(pending, INLINE_DIAGNOSTICS_TIMEOUT_MS).catch(() => undefined)
      if (inline) {
        return {
          servers: inline.servers,
          formatted,
          diagnostics: inline,
          diagnosticsDelayed: false,
          mutationVersion,
        }
      }

      void pending.then(async (diagnostics) => {
        if (mutationVersions.get(mutationKey) !== mutationVersion) return
        const current = await readFile(filePath).catch(() => undefined)
        if (!current || sha256(current) !== expectedSha) return
        input.context.emitEvent?.({
          type: 'system',
          subtype: 'lsp_diagnostics',
          session_id: input.context.sessionId,
          tool_use_id: input.context.toolUseId,
          file_path: filePath,
          mutation_version: mutationVersion,
          sha256: expectedSha,
          delayed: true,
          diagnostics,
        })
      }).catch(() => undefined)

      return {
        servers: clients.map((client) => client.serverName),
        formatted,
        diagnosticsDelayed: true,
        mutationVersion,
      }
    },
  }
}

export async function prepareLspWritethroughBatch(input: {
  files: Array<{ filePath: string; content: string; existedBefore: boolean }>
  context: ToolContext
}): Promise<PreparedLspWritethroughBatch> {
  const contents = new Map(input.files.map((file) => [resolve(file.filePath), file.content]))
  const lsp = lspOptions(input.context)
  if (lsp.enabled === false || input.files.length === 0) {
    return {
      contents,
      async commit() {
        return { servers: [], formatted: false, diagnosticsDelayed: false, mutationVersion: 0 }
      },
    }
  }

  const records: Array<{
    filePath: string
    existedBefore: boolean
    clients: LspClient[]
    versions: Map<string, number>
    before: Map<string, number>
    mutationKey: string
    mutationVersion: number
    expectedSha: string
  }> = []
  for (const file of input.files) {
    const filePath = resolve(file.filePath)
    const clients = await withTimeout(
      getLspClientsForFile(input.context.cwd, input.context.toolConfig, filePath),
      lsp.warmupTimeoutMs,
    ).catch(() => [] as LspClient[])
    const before = new Map(clients.map((client) => [client.serverName, client.getDiagnosticsSequence()]))
    const versions = new Map<string, number>()
    for (const client of clients) {
      versions.set(client.serverName, await client.syncContent(filePath, contents.get(filePath)!).catch(() => 0))
    }
    if (lsp.formatOnWrite) {
      const formatter = clients.find((client) => {
        const capabilities = client.getStatus().capabilities
        return Boolean(capabilities.documentFormattingProvider || capabilities.formattingProvider)
      })
      if (formatter) {
        try {
          const current = contents.get(filePath)!
          const edits = await formatter.request<LspTextEdit[]>('textDocument/formatting', {
            textDocument: { uri: fileUri(filePath) },
            options: inferFormattingOptions(current),
          }, lsp.requestTimeoutMs, input.context.abortSignal)
          const formatted = applyTextEdits(current, edits ?? [])
          if (formatted !== current) {
            contents.set(filePath, formatted)
            for (const client of clients) {
              versions.set(client.serverName, await client.syncContent(filePath, formatted).catch(() => versions.get(client.serverName) ?? 0))
            }
          }
        } catch {
          // Formatting remains advisory for a batch.
        }
      }
    }
    const mutationKey = `${input.context.sessionId ?? input.context.runId ?? 'global'}\0${filePath}`
    const mutationVersion = (mutationVersions.get(mutationKey) ?? 0) + 1
    mutationVersions.set(mutationKey, mutationVersion)
    records.push({
      filePath,
      existedBefore: file.existedBefore,
      clients,
      versions,
      before,
      mutationKey,
      mutationVersion,
      expectedSha: sha256(contents.get(filePath)!),
    })
  }

  return {
    contents,
    async commit() {
      const allClients = [...new Set(records.flatMap((record) => record.clients))]
      await Promise.all(allClients.map(async (client) => {
        const files = records.filter((record) => record.clients.includes(client))
        await client.notifyWatchedFiles(files.map((record) => ({
          uri: fileUri(record.filePath),
          type: record.existedBefore ? 2 as const : 1 as const,
        }))).catch(() => undefined)
        await Promise.all(files.map((record) => client.notifySaved(record.filePath).catch(() => undefined)))
      }))
      if (!lsp.diagnosticsOnWrite) {
        return {
          servers: allClients.map((client) => client.serverName),
          formatted: false,
          diagnosticsDelayed: false,
          mutationVersion: 0,
        }
      }
      const pending = records.map((record) => Promise.all([
        collectFreshDiagnostics(
          record.clients,
          record.filePath,
          record.versions,
          record.before,
          DELAYED_DIAGNOSTICS_TIMEOUT_MS,
          input.context.abortSignal,
        ),
        withTimeout(
          collectLspAdapterDiagnostics(record.filePath, input.context),
          DELAYED_DIAGNOSTICS_TIMEOUT_MS,
        ).catch(() => undefined),
      ]).then(([diagnostics, adapter]) => summarizeDiagnostics([
        ...diagnostics,
        ...(adapter?.diagnostics.items.map((diagnostic) => ({
          ...diagnostic,
          server: diagnostic.server ?? adapter.server,
        })) ?? []),
      ], input.context, record.filePath)))
      const inline = await withTimeout(Promise.all(pending), INLINE_DIAGNOSTICS_TIMEOUT_MS).catch(() => undefined)
      if (!inline) {
        for (const [index, diagnostics] of pending.entries()) {
          const record = records[index]!
          void diagnostics.then(async (batch) => {
            if (mutationVersions.get(record.mutationKey) !== record.mutationVersion) return
            const current = await readFile(record.filePath).catch(() => undefined)
            if (!current || sha256(current) !== record.expectedSha) return
            input.context.emitEvent?.({
              type: 'system',
              subtype: 'lsp_diagnostics',
              session_id: input.context.sessionId,
              tool_use_id: input.context.toolUseId,
              file_path: record.filePath,
              mutation_version: record.mutationVersion,
              sha256: record.expectedSha,
              delayed: true,
              diagnostics: batch,
            })
          }).catch(() => undefined)
        }
      }
      return {
        servers: allClients.map((client) => client.serverName),
        formatted: input.files.some((file) => contents.get(resolve(file.filePath)) !== file.content),
        ...(inline ? { diagnostics: inline.reduce(mergeDiagnosticBatches) } : {}),
        diagnosticsDelayed: !inline,
        mutationVersion: Math.max(0, ...records.map((record) => record.mutationVersion)),
      }
    },
  }
}

async function collectFreshDiagnostics(
  clients: LspClient[],
  filePath: string,
  versions: Map<string, number>,
  beforeSequence: Map<string, number>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<LspAggregatedDiagnostic[]> {
  const results = await Promise.all(clients.map(async (client) => {
    try {
      const diagnostics = await client.waitForDiagnostics(
        filePath,
        timeoutMs,
        signal,
        versions.get(client.serverName),
        beforeSequence.get(client.serverName) ?? 0,
      )
      return diagnostics.map((diagnostic) => ({ ...diagnostic, server: client.serverName }))
    } catch {
      return []
    }
  }))
  const seen = new Set<string>()
  return results.flat().filter((diagnostic) => {
    const key = diagnosticKey(diagnostic)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function summarizeDiagnostics(
  diagnostics: LspAggregatedDiagnostic[],
  context: ToolContext,
  filePath: string,
): Promise<LspDiagnosticBatch> {
  const ledgerKey = `${context.sessionId ?? context.runId ?? 'global'}\0${filePath}`
  const rawLsp = context.toolConfig?.lsp
  const deduplicate = !(rawLsp && typeof rawLsp === 'object' && !Array.isArray(rawLsp)
    && (rawLsp as Record<string, unknown>).diagnosticsDeduplicate === false)
  const previous = deduplicate ? diagnosticLedger.get(ledgerKey) ?? new Set<string>() : new Set<string>()
  const current = new Set(diagnostics.map(diagnosticKey))
  if (deduplicate) diagnosticLedger.set(ledgerKey, current)
  const unseen = diagnostics.filter((diagnostic) => !previous.has(diagnosticKey(diagnostic)))
  const complete = unseen
  const items: LspDiagnosticBatch['items'] = []
  let characters = 0
  for (const diagnostic of complete) {
    if (items.length >= 50 || characters + diagnostic.message.length > 8_000) break
    characters += diagnostic.message.length
    items.push(diagnostic)
  }
  const summary: LspDiagnosticBatch = {
    servers: [...new Set(diagnostics.map((diagnostic) => diagnostic.server))],
    total: complete.length,
    errors: complete.filter((diagnostic) => diagnostic.severity === 1).length,
    warnings: complete.filter((diagnostic) => diagnostic.severity === 2).length,
    truncated: items.length < complete.length,
    items,
  }
  if (summary.truncated && context.artifactsRoot) {
    try {
      const directory = join(context.artifactsRoot, 'lsp-diagnostics')
      await mkdir(directory, { recursive: true })
      const path = join(directory, `${basename(filePath)}-${Date.now()}.json`)
      const body = JSON.stringify(complete, null, 2)
      await writeFile(path, body, 'utf8')
      const info = await stat(path)
      summary.artifact = { kind: 'file', path, size: info.size, mimeType: 'application/json' }
    } catch {
      // A missing artifact must not hide the bounded inline diagnostics.
    }
  }
  return summary
}

function lspOptions(context: ToolContext): {
  enabled: boolean
  diagnosticsOnWrite: boolean
  formatOnWrite: boolean
  requestTimeoutMs?: number
  warmupTimeoutMs: number
} {
  const raw = context.toolConfig?.lsp
  const lsp = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  return {
    enabled: lsp.enabled !== false,
    diagnosticsOnWrite: lsp.diagnosticsOnWrite !== false,
    formatOnWrite: lsp.formatOnWrite === true,
    requestTimeoutMs: typeof lsp.requestTimeoutMs === 'number'
      ? positiveMs(lsp.requestTimeoutMs, 20_000, 300_000)
      : undefined,
    warmupTimeoutMs: positiveMs(lsp.warmupTimeoutMs, 5_000, 5_000),
  }
}

function noLsp(content: string): PreparedLspWritethrough {
  return {
    content,
    async commit() {
      return { servers: [], formatted: false, diagnosticsDelayed: false, mutationVersion: 0 }
    },
  }
}

function inferFormattingOptions(content: string): { tabSize: number; insertSpaces: boolean } {
  const indentation = content.split(/\r?\n/).map((line) => line.match(/^( +|\t+)/)?.[1]).find(Boolean)
  return {
    tabSize: indentation && !indentation.includes('\t') ? Math.max(indentation.length, 1) : 2,
    insertSpaces: !indentation?.includes('\t'),
  }
}

function fileUri(filePath: string): string {
  return pathToFileURL(resolve(filePath)).toString()
}

function diagnosticKey(diagnostic: LspAggregatedDiagnostic): string {
  return [
    diagnostic.range.start.line,
    diagnostic.range.start.character,
    diagnostic.range.end.line,
    diagnostic.range.end.character,
    diagnostic.severity ?? '',
    diagnostic.code ?? '',
    diagnostic.message,
  ].join('|')
}

function mergeDiagnosticBatches(left: LspDiagnosticBatch, right: LspDiagnosticBatch): LspDiagnosticBatch {
  const items = [...left.items, ...right.items]
  return {
    servers: [...new Set([...left.servers, ...right.servers])],
    total: left.total + right.total,
    errors: left.errors + right.errors,
    warnings: left.warnings + right.warnings,
    truncated: left.truncated || right.truncated,
    items: items.slice(0, 50),
    ...(left.artifact ? { artifact: left.artifact } : right.artifact ? { artifact: right.artifact } : {}),
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function positiveMs(value: unknown, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), maximum)
    : fallback
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('LSP operation timed out')), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
