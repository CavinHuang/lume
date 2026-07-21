import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WikiAclStore, pageAllowed, sourceAllowed } from './acl-store'
import { WikiHealthStore } from './health-store'
import { createWikiPageMarkdown, parseWikiPage, serializeWikiPage, WikiMarkdownStore } from './markdown-store'
import { WikiMutationCoordinator } from './mutation-coordinator'
import { resolveWikiPath } from './path-security'
import { isPublicIpAddress, WikiSafeHttpFetchService } from './safe-http-fetch'
import { WikiSourceStore } from './source-store'
import { cjkNgrams } from './search-text'
import { toWikiSearchPageRef } from './index-service'

const roots: string[] = []
const uuid = '11111111-1111-4111-8111-111111111111'
function root(): string { const value = mkdtempSync(join(tmpdir(), 'lume-wiki-')); roots.push(value); return value }
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

describe('wiki stores and security', () => {
  test('builds deterministic CJK bigrams and trigrams without LIKE fallback', () => {
    expect(cjkNgrams('知识库')).toEqual(['知识', '识库', '知识库'])
    expect(cjkNgrams('知')).toEqual(['知'])
  })
  test('round-trips inbox markdown with stable identity', () => {
    const markdown = createWikiPageMarkdown({ type: 'topic', title: '中文主题', primaryWorkspace: null, body: '# 摘要\n\n内容' })
    const page = parseWikiPage(markdown, 'inbox/page.md')
    expect(page.frontmatter.primary_workspace_id).toBeNull()
    expect(page.fileKey).toStartWith('wiki-')
    expect(page.body).toContain('内容')
  })

  test('rejects a symlink or junction inside the vault for reads', () => {
    const vault = root(); const outside = root()
    writeFileSync(join(outside, 'secret.md'), 'secret')
    const link = join(vault, 'escape')
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => resolveWikiPath(vault, 'escape/secret.md')).toThrow()
    expect(() => new WikiMarkdownStore(vault).atomicReplace('escape/new.md', 'outside')).toThrow()
  })

  test('keeps page visibility and provenance grants as serial gates', () => {
    const vault = root(); const acl = new WikiAclStore(vault)
    const markdown = createWikiPageMarkdown({ type: 'source', title: 'Source', primaryWorkspace: { id: uuid, name: 'W', slug: 'w' }, sourceIds: ['source-1'] })
    const page = parseWikiPage(markdown)
    const subject = { kind: 'desktop_agent' as const, subjectId: 'agent', workspaceIds: [uuid], allowInbox: false, allowAll: false }
    const scope = { kind: 'workspace' as const, workspaceId: uuid }
    expect(pageAllowed(page.frontmatter, subject, scope)).toBe(true)
    expect(pageAllowed(page.frontmatter, { kind: 'desktop_owner', subjectId: 'owner', workspaceIds: [], allowInbox: true, allowAll: true }, scope)).toBe(true)
    expect(sourceAllowed('source-1', page.frontmatter, subject, scope, acl)).toBe(false)
    acl.append('source-1', uuid, 'grant', 'owner')
    expect(sourceAllowed('source-1', page.frontmatter, subject, scope, acl)).toBe(true)
    acl.append('source-1', uuid, 'revoke', 'owner')
    expect(sourceAllowed('source-1', page.frontmatter, subject, scope, acl)).toBe(false)
  })

  test('deduplicates blobs without merging provenance and only GCs at zero refs', () => {
    const vault = root(); const sources = new WikiSourceStore(vault)
    const payload = new TextEncoder().encode('same')
    const make = () => sources.createManifest({ kind: 'text', title: 'S', capture_mode: 'snapshotted', capture_scope_snapshot: { capturedBy: 'desktop_owner' }, locator: {}, media_type: 'text/plain', warnings: [], payload })
    const first = make(); const second = make(); sources.commit(first.manifest, first.payload); sources.commit(second.manifest, second.payload)
    expect(() => sources.commit(first.manifest, first.payload)).not.toThrow()
    expect(first.manifest.id).not.toBe(second.manifest.id)
    expect(first.manifest.blob_hash).toBe(second.manifest.blob_hash)
    sources.purge(first.manifest.id, 'owner')
    expect(readFileSync(sources.blobPath(first.manifest.blob_hash!), 'utf8')).toBe('same')
    sources.purge(second.manifest.id, 'owner')
    expect(sources.readPayload(second.manifest.id)).toBeUndefined()
  })

  test('applies only an immutable sidecar draft with nonce and before hash', () => {
    const vault = root(); const coordinator = new WikiMutationCoordinator(vault)
    const markdown = createWikiPageMarkdown({ type: 'topic', title: 'Draft', primaryWorkspace: null })
    const page = parseWikiPage(markdown)
    const target = `inbox/${page.fileKey}.md`
    const draft = coordinator.stageDraft({ origin: 'ui', risk: 'low', riskReasons: [], title: 'Create', operations: [{ kind: 'create', pageId: page.id, beforeHash: null, targetRelativePath: target, markdown }], sources: [], diffs: [{ pageId: page.id, path: target, beforeHash: null, afterHash: page.hash, preview: 'create' }], pageVisibilityWorkspaceIds: [], sourceGrantWorkspaceIds: [] })
    expect(coordinator.getDraftStatus(draft.id).state).toBe('pending')
    expect(() => coordinator.applyDraft({ draftId: draft.id, expectedRevision: 1, nonce: 'forged' })).toThrow()
    const batch = coordinator.applyDraft({ draftId: draft.id, expectedRevision: 1, nonce: draft.nonce })
    expect('state' in batch && batch.state).toBe('committed')
    expect(coordinator.getDraftStatus(draft.id).state).toBe('applied')
    expect(new WikiMarkdownStore(vault).readById(page.id)?.title).toBe('Draft')

    const cancelled = coordinator.stageDraft({ origin: 'ui', risk: 'low', riskReasons: [], title: 'Cancel', operations: [], sources: [], diffs: [], pageVisibilityWorkspaceIds: [], sourceGrantWorkspaceIds: [] })
    expect(coordinator.getDraftStatus(cancelled.id).state).toBe('pending')
    coordinator.cancelDraft(cancelled.id)
    expect(coordinator.getDraftStatus(cancelled.id).state).toBe('unavailable')
  })

  test('projects search hits to lightweight page refs instead of returning full page bodies', () => {
    const page = parseWikiPage(createWikiPageMarkdown({
      type: 'topic', title: '轻量搜索结果', primaryWorkspace: null, body: '正文'.repeat(20_000),
    }))
    const ref = toWikiSearchPageRef(page)

    expect(ref.id).toBe(page.id)
    expect(ref.title).toBe(page.title)
    expect(ref).not.toHaveProperty('body')
    expect(ref).not.toHaveProperty('markdown')
    expect(ref).not.toHaveProperty('frontmatter')
    expect(JSON.stringify(ref).length).toBeLessThan(1_000)
  })

  test('resumes an interrupted journal without replaying completed files', () => {
    const vault = root(); const coordinator = new WikiMutationCoordinator(vault)
    const firstMarkdown = createWikiPageMarkdown({ type: 'topic', title: 'First', primaryWorkspace: null })
    const secondMarkdown = createWikiPageMarkdown({ type: 'topic', title: 'Second', primaryWorkspace: null })
    const first = parseWikiPage(firstMarkdown); const second = parseWikiPage(secondMarkdown)
    const firstPath = `inbox/${first.fileKey}.md`; const secondPath = `inbox/${second.fileKey}.md`
    const draft = coordinator.stageDraft({
      origin: 'import', risk: 'low', riskReasons: [], title: 'Two pages', sources: [],
      operations: [
        { kind: 'create', pageId: first.id, beforeHash: null, targetRelativePath: firstPath, markdown: firstMarkdown },
        { kind: 'create', pageId: second.id, beforeHash: null, targetRelativePath: secondPath, markdown: secondMarkdown },
      ],
      diffs: [
        { pageId: first.id, path: firstPath, beforeHash: null, afterHash: first.hash, preview: 'first' },
        { pageId: second.id, path: secondPath, beforeHash: null, afterHash: second.hash, preview: 'second' },
      ], pageVisibilityWorkspaceIds: [], sourceGrantWorkspaceIds: [],
    })
    coordinator.markdown.atomicReplace(firstPath, firstMarkdown)
    const batch = { id: randomUUID(), draftId: draft.id, state: 'applying', fencingToken: 1, actor: 'test', origin: draft.origin, risk: draft.risk, createdAt: new Date().toISOString(), diffs: draft.diffs, affectedPageIds: [first.id, second.id] } as const
    writeFileSync(resolveWikiPath(vault, `.lume/operations/${batch.id}.json`), JSON.stringify(batch))

    expect(coordinator.recoverInterrupted()).toEqual([batch.id])
    expect(coordinator.markdown.readById(first.id)?.title).toBe('First')
    expect(coordinator.markdown.readById(second.id)?.title).toBe('Second')
    expect(JSON.parse(readFileSync(resolveWikiPath(vault, `.lume/operations/${batch.id}.json`), 'utf8')).state).toBe('committed')
    expect(existsSync(resolveWikiPath(vault, `.lume/staging/${draft.id}`))).toBe(false)
  })

  test('protects external edits instead of completing an interrupted journal over them', () => {
    const vault = root(); const coordinator = new WikiMutationCoordinator(vault)
    const markdown = createWikiPageMarkdown({ type: 'topic', title: 'Original', primaryWorkspace: null })
    const page = parseWikiPage(markdown); const target = `inbox/${page.fileKey}.md`
    const draft = coordinator.stageDraft({ origin: 'ui', risk: 'low', riskReasons: [], title: 'Create', operations: [{ kind: 'create', pageId: page.id, beforeHash: null, targetRelativePath: target, markdown }], sources: [], diffs: [{ pageId: page.id, path: target, beforeHash: null, afterHash: page.hash, preview: 'create' }], pageVisibilityWorkspaceIds: [], sourceGrantWorkspaceIds: [] })
    const external = serializeWikiPage({ ...page.frontmatter, title: 'External', revision: 2 }, '# 用户批注\n\nObsidian edit')
    coordinator.markdown.atomicReplace(target, external)
    const batch = { id: randomUUID(), draftId: draft.id, state: 'applying', fencingToken: 1, actor: 'test', origin: draft.origin, risk: draft.risk, createdAt: new Date().toISOString(), diffs: draft.diffs, affectedPageIds: [page.id] } as const
    writeFileSync(resolveWikiPath(vault, `.lume/operations/${batch.id}.json`), JSON.stringify(batch))

    expect(coordinator.recoverInterrupted()).toEqual([])
    expect(coordinator.markdown.readById(page.id)?.title).toBe('External')
    expect(coordinator.markdown.readById(page.id)?.protected).toBe(true)
    expect(coordinator.listPending()[0]?.requiresRegeneration).toBe(true)
  })

  test('records an unavailable semantic due-check only once per generation', () => {
    const vault = root(); let now = Date.parse('2026-07-17T00:00:00.000Z')
    const health = new WikiHealthStore(vault, () => now)
    const first = health.evaluate(42, [])
    now += 60_000
    const repeated = health.evaluate(42, [])
    const nextGeneration = health.evaluate(43, [])
    expect(first.status).toBe('unavailable')
    expect(repeated).toEqual(first)
    expect(nextGeneration).not.toEqual(first)
    expect(first.message).toContain('语义检查未执行')
  })

  test('persists one semantic background run with model, generation, duration and findings', () => {
    const vault = root(); let now = Date.parse('2026-07-17T00:00:00.000Z')
    const health = new WikiHealthStore(vault, () => now)
    expect(health.begin(9, [])).toBe(true)
    expect(health.begin(9, [])).toBe(false)
    now += 250
    health.complete({ generation: 9, model: 'local-onnx/test', durationMs: 250, findings: [{ id: 'f', rule: 'near-duplicate', severity: 'warning', message: 'duplicate', pageId: uuid, createdAt: new Date(now).toISOString(), generation: 9 }] })
    expect(health.snapshot()).toMatchObject({ status: 'completed', generation: 9, model: 'local-onnx/test', durationMs: 250, findingCounts: { warning: 1 } })
    expect(health.begin(9, [])).toBe(false)
  })


  test('revalidates every redirect DNS hop and rejects private targets', async () => {
    const requested: string[] = []
    const service = new WikiSafeHttpFetchService({
      resolve: async (host) => [{ address: host === 'public.test' ? '93.184.216.34' : '127.0.0.1', family: 4 }],
      request: async (url) => { requested.push(url.hostname); return { status: 302, headers: { location: 'http://private.test/secret' }, body: new Uint8Array() } },
    })
    await expect(service.fetch('http://public.test')).rejects.toThrow('非公网')
    expect(requested).toEqual(['public.test'])
  })

  test('rejects mixed DNS, rebinding, reserved IPs and nonstandard ports', async () => {
    expect(isPublicIpAddress('10.0.0.1')).toBe(false)
    expect(isPublicIpAddress('169.254.1.1')).toBe(false)
    expect(isPublicIpAddress('::1')).toBe(false)
    expect(isPublicIpAddress('2001:db8::1')).toBe(false)
    expect(isPublicIpAddress('93.184.216.34')).toBe(true)
    const mixed = new WikiSafeHttpFetchService({ resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }], request: async () => ({ status: 200, headers: {}, body: new Uint8Array() }) })
    await expect(mixed.fetch('https://public.test')).rejects.toThrow('混合地址')
    let calls = 0
    const rebinding = new WikiSafeHttpFetchService({
      resolve: async () => ++calls === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }],
      request: async () => ({ status: 302, headers: { location: 'https://public.test/again' }, body: new Uint8Array() }),
    })
    await expect(rebinding.fetch('https://public.test')).rejects.toThrow('非公网')
    await expect(rebinding.fetch('https://public.test:444')).rejects.toThrow('标准端口')
  })

  test('pins the validated address while preserving the original hostname contract and limits', async () => {
    const observations: unknown[] = []
    const service = new WikiSafeHttpFetchService({
      resolve: async (hostname) => { observations.push({ hostname }); return [{ address: '93.184.216.34', family: 4 }] },
      request: async (url, address, options) => { observations.push({ url: url.hostname, address: address.address, options }); return { status: 200, headers: { 'content-type': 'text/plain' }, body: new TextEncoder().encode('ok') } },
    })
    expect(new TextDecoder().decode((await service.fetch('https://example.test/path', { maxBytes: 123, connectTimeoutMs: 456, totalTimeoutMs: 789 })).body)).toBe('ok')
    expect(observations).toEqual([{ hostname: 'example.test' }, { url: 'example.test', address: '93.184.216.34', options: { maxBytes: 123, connectTimeoutMs: 456, totalTimeoutMs: 789 } }])
    const source = readFileSync(new URL('./safe-http-fetch.ts', import.meta.url), 'utf8')
    expect(source).toContain('servername: url.hostname')
    expect(source).toContain('headers: { Host: url.host')
    expect(source).toContain('callback(null, address.address, address.family)')
  })

  test('only takes over a dead writer and advances the fencing token', () => {
    const vault = root(); const coordinator = new WikiMutationCoordinator(vault)
    const markdown = createWikiPageMarkdown({ type: 'topic', title: 'Fence', primaryWorkspace: null }); const page = parseWikiPage(markdown); const target = `inbox/${page.fileKey}.md`
    const draft = coordinator.stageDraft({ origin: 'ui', risk: 'low', riskReasons: [], title: 'Fence', operations: [{ kind: 'create', pageId: page.id, beforeHash: null, targetRelativePath: target, markdown }], sources: [], diffs: [{ pageId: page.id, path: target, beforeHash: null, afterHash: page.hash, preview: 'create' }], pageVisibilityWorkspaceIds: [], sourceGrantWorkspaceIds: [] })
    const lockPath = resolveWikiPath(vault, '.lume/operations/writer.lock')
    writeFileSync(lockPath, JSON.stringify({ ownerPid: process.pid, ownerId: 'alive', fencingToken: 7, heartbeatAt: new Date().toISOString() }))
    expect(() => coordinator.applyDraft({ draftId: draft.id, expectedRevision: draft.revision, nonce: draft.nonce })).toThrow('存活 writer')
    writeFileSync(lockPath, JSON.stringify({ ownerPid: 2147483647, ownerId: 'dead', fencingToken: 7, heartbeatAt: new Date().toISOString() }))
    writeFileSync(resolveWikiPath(vault, '.lume/operations/fencing-token'), '7')
    const batch = coordinator.applyDraft({ draftId: draft.id, expectedRevision: draft.revision, nonce: draft.nonce })
    expect('fencingToken' in batch && batch.fencingToken).toBe(8)
  })

})
