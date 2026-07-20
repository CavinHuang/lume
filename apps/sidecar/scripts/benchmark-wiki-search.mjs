import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'

const PAGE_COUNT = 5_000
const SECTION_COUNT = 50_000
const root = mkdtempSync(join(tmpdir(), 'lume-wiki-benchmark-'))
const database = new DatabaseSync(join(root, 'wiki.sqlite'))

try {
  database.exec(`
    PRAGMA journal_mode=OFF;
    PRAGMA synchronous=OFF;
    CREATE TABLE pages(id TEXT PRIMARY KEY, title TEXT NOT NULL, alias TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE sections(page_id TEXT NOT NULL, content TEXT NOT NULL);
    CREATE VIRTUAL TABLE pages_fts USING fts5(page_id UNINDEXED, content, tokenize='trigram');
  `)
  const insertPage = database.prepare('INSERT INTO pages VALUES(?,?,?,?)')
  const insertSection = database.prepare('INSERT INTO sections VALUES(?,?)')
  const insertFts = database.prepare('INSERT INTO pages_fts(page_id,content) VALUES(?,?)')
  database.exec('BEGIN')
  for (let page = 0; page < PAGE_COUNT; page += 1) {
    const id = `page-${String(page).padStart(5, '0')}`
    const title = page % 17 === 0 ? `知识治理 ${page}` : `主题 ${page}`
    const alias = page % 29 === 0 ? `LLM Wiki ${page}` : ''
    const body = `这是第 ${page} 个中英文混合页面，讨论 knowledge maintenance、来源与工作区归属。`
    insertPage.run(id, title, alias, body)
    insertFts.run(id, `${title}\n${alias}\n${body}`)
    for (let section = 0; section < SECTION_COUNT / PAGE_COUNT; section += 1) insertSection.run(id, `${body} 段落 ${section}`)
  }
  database.exec('COMMIT')

  const lexical = database.prepare("SELECT page_id FROM pages_fts WHERE pages_fts MATCH ? ORDER BY bm25(pages_fts) LIMIT 50")
  lexical.all('"知识治理"')
  const lexicalDurations = Array.from({ length: 20 }, () => {
    const started = performance.now()
    lexical.all('"知识治理" OR "knowledge"')
    return performance.now() - started
  }).sort((left, right) => left - right)
  const lexicalP95Ms = lexicalDurations[Math.floor(lexicalDurations.length * 0.95)]

  const dimensions = 384
  const query = new Float32Array(dimensions).fill(1 / Math.sqrt(dimensions))
  const vectors = Array.from({ length: PAGE_COUNT }, (_, page) => {
    const vector = new Float32Array(dimensions)
    for (let index = 0; index < dimensions; index += 1) vector[index] = ((page + index) % 31) / 31
    return vector
  })
  const hybridStarted = performance.now()
  const scores = vectors.map((vector, page) => {
    let score = 0
    for (let index = 0; index < dimensions; index += 1) score += query[index] * vector[index]
    return { page, score }
  }).sort((left, right) => right.score - left.score).slice(0, 200)
  const hybridWarmMs = performance.now() - hybridStarted

  const result = { pages: PAGE_COUNT, sections: SECTION_COUNT, lexicalP95Ms, hybridWarmMs, candidates: scores.length }
  console.log(JSON.stringify(result))
  if (lexicalP95Ms >= 300) throw new Error(`Wiki warm lexical search exceeded 300ms: ${lexicalP95Ms.toFixed(1)}ms`)
  if (hybridWarmMs >= 2_000) throw new Error(`Wiki local hybrid scan exceeded 2s: ${hybridWarmMs.toFixed(1)}ms`)
} finally {
  database.close()
  rmSync(root, { recursive: true, force: true })
}
