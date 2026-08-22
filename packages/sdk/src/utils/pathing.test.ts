import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensurePathAllowed, isFakeIpRange, resolveInputPath, toPathKey } from "./pathing.js"

describe("isFakeIpRange", () => {
  test("matches the 198.18.0.0/15 fake-IP benchmark range", () => {
    expect(isFakeIpRange("198.18.0.1")).toBe(true)
    expect(isFakeIpRange("198.19.255.254")).toBe(true)
  })

  test("rejects adjacent and unrelated ranges", () => {
    expect(isFakeIpRange("198.17.0.1")).toBe(false)
    expect(isFakeIpRange("198.20.0.1")).toBe(false)
    expect(isFakeIpRange("10.0.0.1")).toBe(false)
    expect(isFakeIpRange("::1")).toBe(false)
    expect(isFakeIpRange("not-an-ip")).toBe(false)
  })
})

describe("toPathKey", () => {
  test("folds case exactly where the filesystem is case-insensitive (#334)", () => {
    const foldsCase = process.platform === "win32" || process.platform === "darwin"
    expect(toPathKey("/w/File.TXT") === toPathKey("/w/file.txt")).toBe(foldsCase)
  })

  test("normalizes separators and relative segments", () => {
    expect(toPathKey("/w/a/../b.txt")).toBe(toPathKey("/w/b.txt"))
  })
})

// Windows needs admin or Developer Mode for real symlinks; probe once and
// skip the symlink-specific tests where creation is not permitted.
const symlinkProbeDir = mkdtempSync(join(tmpdir(), "lume-pathing-probe-"))
let symlinksSupported = false
try {
  symlinkSync("target", join(symlinkProbeDir, "probe"), "file")
  symlinksSupported = true
} catch {
  // keep the suite green on locked-down Windows environments
}
afterAll(() => rmSync(symlinkProbeDir, { recursive: true, force: true }))

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

describe("symlink-aware path resolution (#336)", () => {
  test.skipIf(!symlinksSupported)("resolveInputPath returns the realpath through a file symlink", async () => {
    const root = makeTempDir("lume-pathing-file-")
    writeFileSync(join(root, "real.txt"), "x", "utf8")
    symlinkSync(join(root, "real.txt"), join(root, "link.txt"), "file")

    const resolved = await resolveInputPath(root, join(root, "link.txt"))

    expect(resolved).toBe(realpathSync(join(root, "real.txt")))
  })

  test.skipIf(!symlinksSupported)("resolveInputPath resolves a directory-symlink ancestor", async () => {
    const root = makeTempDir("lume-pathing-dir-")
    mkdirSync(join(root, "realdir"))
    writeFileSync(join(root, "realdir", "f.txt"), "x", "utf8")
    symlinkSync(
      join(root, "realdir"),
      join(root, "linkdir"),
      process.platform === "win32" ? "junction" : "dir",
    )

    const resolved = await resolveInputPath(root, join(root, "linkdir", "f.txt"))

    expect(resolved).toBe(realpathSync(join(root, "realdir", "f.txt")))
  })

  test.skipIf(!symlinksSupported)("ensurePathAllowed denies a write symlink escaping allowWrite", () => {
    const root = makeTempDir("lume-pathing-escape-")
    mkdirSync(join(root, "in"))
    mkdirSync(join(root, "out"))
    symlinkSync(join(root, "out", "secret.txt"), join(root, "in", "link.txt"), "file")
    const sandbox = { enabled: true, filesystem: { allowWrite: [join(root, "in")] } }

    expect(ensurePathAllowed(join(root, "in", "link.txt"), "write", sandbox)).toContain("denied")
    // positive controls: plain and not-yet-existing files inside stay allowed
    expect(ensurePathAllowed(join(root, "in", "plain.txt"), "write", sandbox)).toBeNull()
    expect(ensurePathAllowed(join(root, "outside.txt"), "write", sandbox)).toContain("denied")
  })

  test.skipIf(!symlinksSupported)("ensurePathAllowed denies a read symlink into denyRead", () => {
    const root = makeTempDir("lume-pathing-denyread-")
    mkdirSync(join(root, "secret"))
    mkdirSync(join(root, "open"))
    symlinkSync(join(root, "secret", "key.txt"), join(root, "open", "door.txt"), "file")
    const sandbox = { enabled: true, filesystem: { denyRead: [join(root, "secret")] } }

    expect(ensurePathAllowed(join(root, "open", "door.txt"), "read", sandbox)).toContain("denied")
    expect(ensurePathAllowed(join(root, "open", "plain.txt"), "read", sandbox)).toBeNull()
  })
})
