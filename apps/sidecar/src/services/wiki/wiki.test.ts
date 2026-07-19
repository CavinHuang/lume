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
import { WikiSafeHttpFetchService } from './safe-http-fetch'
import { WikiSourceStore } from './source-store'
import { cjkNgrams } from './search-text'

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
    const draft = coordinator.stageDraft({ origin: 'ui', risk: 'low', riskReasons: [], title: 'Create', operations: [{ kind: 'create', pageId: page.id, beforeHash: null, targetRelativePath: target, markdown }], sources: [], diffs: [{ path: target, beforeHash: null, afterHash: page.hash, preview: 'create' }], pageVisibilityWorkspaceIds: [], sourceGrantWorkspaceIds: [] })
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
        { path: firstPath, beforeHash: null, afterHash: first.hash, preview: 'first' },
        { path: secondPath, beforeHash: null, afterHash: second.hash, preview: 'second' },
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
    const draft = coordinator.stageDraft({ origin: 'ui', risk: 'low', riskReasons: [], title: 'Create', operations: [{ kind: 'create', pageId: page.id, beforeHash: null, targetRelativePath: target, markdown }], sources: [], diffs: [{ path: target, beforeHash: null, afterHash: page.hash, preview: 'create' }], pageVisibilityWorkspaceIds: [], sourceGrantWorkspaceIds: [] })
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


  test('revalidates every redirect DNS hop and rejects private targets', async () => {
    const requested: string[] = []
    const service = new WikiSafeHttpFetchService({
      resolve: async (host) => [{ address: host === 'public.test' ? '93.184.216.34' : '127.0.0.1', family: 4 }],
      request: async (url) => { requested.push(url.hostname); return { status: 302, headers: { location: 'http://private.test/secret' }, body: new Uint8Array() } },
    })
    await expect(service.fetch('http://public.test')).rejects.toThrow('非公网')
    expect(requested).toEqual(['public.test'])
  })

})
