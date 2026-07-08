import { writeFileSync } from 'node:fs'
import { buildGeneratedFromCatalog, type Catalog } from '../src/data/catalog-mapping'

const CATALOG_URL = 'https://models.dev/catalog.json'
const OUTPUT_PATH = new URL('../src/data/model-meta.generated.json', import.meta.url)

async function fetchCatalog(): Promise<Catalog> {
  const res = await fetch(CATALOG_URL)
  if (!res.ok) throw new Error(`fetch ${CATALOG_URL}: HTTP ${res.status}`)
  return (await res.json()) as Catalog
}

async function main(): Promise<void> {
  const catalog = await fetchCatalog()
  const generated = buildGeneratedFromCatalog(catalog)
  // 不直接写 OUTPUT_PATH：先序列化成功后再落盘，避免中途失败污染现有文件
  const json = `${JSON.stringify(generated, null, 2)}\n`
  writeFileSync(OUTPUT_PATH, json, 'utf8')
  console.log(`[sync-models] wrote ${generated.length} models → ${OUTPUT_PATH.pathname}`)
}

if (import.meta.path === Bun.main) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
