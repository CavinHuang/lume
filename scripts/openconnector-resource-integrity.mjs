import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function assertArchiveChecksum(path, expected) {
  const actual = sha256File(path)
  if (actual !== expected) throw new Error(`OpenConnector archive checksum mismatch: expected ${expected}, got ${actual}`)
}
