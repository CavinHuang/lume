import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)

function send(payload) {
  process.parentPort.postMessage(JSON.stringify(payload))
}

async function run() {
  const binaryPath = process.env.LUME_NATIVES_PATH
  if (!binaryPath) throw new Error('missing LUME_NATIVES_PATH')

  const native = require(binaryPath)
  for (const name of [
    'countTokens',
    'search',
    'hasMatch',
    'grep',
    'glob',
    'fuzzyFind',
    'listWorkspace',
    'summarize',
    'invalidateFsScanCache',
  ]) {
    if (typeof native[name] !== 'function') {
      throw new Error(`missing native export: ${name}`)
    }
  }

  const root = mkdtempSync(join(tmpdir(), 'lume-native-smoke-'))
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'src', 'main.ts'), 'export function needle() { return "needle"; }\n')
    writeFileSync(join(root, 'docs', 'AGENTS.md'), 'rules\n')

    const tokenCount = native.countTokens({ text: 'hello world' }).count
    if (!(tokenCount > 0)) throw new Error(`unexpected token count: ${tokenCount}`)

    const search = native.search('alpha\nbeta\n', { pattern: 'beta' })
    if (search.matchCount !== 1 && search.match_count !== 1) {
      throw new Error(`unexpected search result: ${JSON.stringify(search)}`)
    }
    if (native.hasMatch('alpha\nbeta\n', 'gamma') !== false) {
      throw new Error('hasMatch returned true for absent pattern')
    }

    const grep = await native.grep({
      pattern: 'needle',
      path: root,
      mode: 'content',
      gitignore: true,
      cache: true,
      maxCount: 10,
      max_count: 10,
    })
    if (!Array.isArray(grep.matches) || grep.matches.length === 0) {
      throw new Error(`unexpected grep result: ${JSON.stringify(grep)}`)
    }

    const glob = await native.glob({
      pattern: '**/*.ts',
      path: root,
      fileType: 1,
      gitignore: true,
      cache: true,
      maxResults: 10,
    })
    if (!Array.isArray(glob.matches) || glob.matches.length === 0) {
      throw new Error(`unexpected glob result: ${JSON.stringify(glob)}`)
    }

    const fuzzy = await native.fuzzyFind({
      query: 'main',
      path: root,
      maxResults: 10,
    })
    if (!Array.isArray(fuzzy.matches) || fuzzy.matches.length === 0) {
      throw new Error(`unexpected fuzzy result: ${JSON.stringify(fuzzy)}`)
    }

    const workspace = await native.listWorkspace({
      path: root,
      maxDepth: 3,
      collectAgentsMd: true,
    })
    const agents = workspace.agentsMdFiles ?? workspace.agents_md_files ?? []
    if (!Array.isArray(agents) || !agents.some((path) => path.replaceAll('\\', '/').endsWith('docs/AGENTS.md'))) {
      throw new Error(`unexpected workspace result: ${JSON.stringify(workspace)}`)
    }

    const summary = native.summarize({
      code: 'function greet(name: string) {\n  return `hello ${name}`;\n}\n',
      lang: 'typescript',
    })
    if (!summary.parsed || !Array.isArray(summary.segments) || summary.segments.length === 0) {
      throw new Error(`unexpected summary result: ${JSON.stringify(summary)}`)
    }

    native.invalidateFsScanCache(root)
    send({ ok: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

run().catch((error) => {
  send({ ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) })
})
