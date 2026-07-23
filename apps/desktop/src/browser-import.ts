import { createHash, createDecipheriv, pbkdf2Sync } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, platform, tmpdir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createRequire } from "node:module"
import { setTimeout as delay } from "node:timers/promises"

const execFileAsync = promisify(execFile)
const runtimeRequire = createRequire(import.meta.url)
const CHROME_EPOCH_US = 11644473600000000
export type ChromeImportProfile = { id: string; name: string; platform: "win32" | "darwin"; hasCookies: boolean; hasPasswords: boolean }
export type ChromeImportReport = { imported: { cookies: number; passwords: number }; skipped: { cookies: number; passwords: number }; failed: { cookies: number; passwords: number }; reasons: Record<string, number>; errors: string[]; profileId: string }
type SecretStorage = { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString?(value: Buffer): string }
export type ImportedCookie = { url: string; name: string; value: string; path: string; domain?: string; expirationDate?: number; secure: boolean; httpOnly: boolean; sameSite?: "unspecified" | "no_restriction" | "lax" | "strict" }
type ImportOptions = { profileId: string; cookies: boolean; passwords: boolean; acknowledged: boolean; configDir: string; safeStorage: SecretStorage; emit?: (params: Record<string, unknown>) => void; cancelled?: () => boolean; onCookie?: (cookie: ImportedCookie) => Promise<(() => Promise<void>) | void> }
type ChromeCryptoContext = { platform: "win32" | "darwin"; key: Buffer | null; unprotect?: (value: Buffer) => Promise<Buffer | null> }

export function classifyChromeImportError(error: unknown): "profile_missing" | "database_locked" | "keychain_denied" | "app_bound_unsupported" | "invalid_database" | "unknown" {
  const message = error instanceof Error ? error.message : String(error)
  if (/profile_not_found/.test(message)) return "profile_missing"
  if (/locked|busy/.test(message)) return "database_locked"
  if (/keychain|protected|decrypt/i.test(message)) return "keychain_denied"
  if (/v20|app.bound/i.test(message)) return "app_bound_unsupported"
  if (/database_invalid|sqlite/i.test(message)) return "invalid_database"
  return "unknown"
}

export function mergeImportedPasswords<T extends { origin: string; username: string }>(existing: T[], incoming: T[]): T[] {
  const merged = new Map(existing.map((entry) => [`${entry.origin}\u0000${entry.username}`, entry]))
  for (const entry of incoming) merged.set(`${entry.origin}\u0000${entry.username}`, entry)
  return [...merged.values()]
}

export function decryptWindowsV10Value(value: Buffer, key: Buffer): string | null {
  if (!value.subarray(0, 3).equals(Buffer.from("v10")) && !value.subarray(0, 3).equals(Buffer.from("v11"))) return null
  if (key.length !== 32 || value.length < 31) return null
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(3, 15))
    decipher.setAuthTag(value.subarray(-16))
    return Buffer.concat([decipher.update(value.subarray(15, -16)), decipher.final()]).toString("utf8")
  } catch { return null }
}

export function deriveMacChromeKey(password: string, iterations = 1003): Buffer {
  return pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1")
}

export function decryptMacV10Value(value: Buffer, key: Buffer): string | null {
  if (!value.subarray(0, 3).equals(Buffer.from("v10")) && !value.subarray(0, 3).equals(Buffer.from("v11"))) return null
  if (key.length !== 16) return null
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "))
    return Buffer.concat([decipher.update(value.subarray(3)), decipher.final()]).toString("utf8")
  } catch { return null }
}

export function decryptLegacyDpapiValue(value: Buffer, unprotect: (value: Buffer) => Buffer | null): string | null {
  try { return unprotect(value)?.toString("utf8") ?? null } catch { return null }
}

export function atomicWriteEncryptedVault(path: string, records: unknown[], safeStorage: SecretStorage): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("secure_storage_unavailable")
  const directory = join(path, "..")
  mkdirSync(directory, { recursive: true })
  for (const candidate of [directory, path]) {
    if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) throw new Error("vault_symlink_rejected")
  }
  const temporary = path + "." + process.pid + "." + Date.now() + ".tmp"
  const backup = path + ".bak"
  try {
    writeFileSync(temporary, safeStorage.encryptString(JSON.stringify(records)), { flag: "wx", mode: 0o600 })
    if (existsSync(path)) {
      rmSync(backup, { force: true })
      renameSync(path, backup)
    }
    try { renameSync(temporary, path) } catch (error) {
      if (existsSync(path)) rmSync(path, { force: true })
      if (existsSync(backup)) renameSync(backup, path)
      throw error
    }
    rmSync(backup, { force: true })
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function readEncryptedVault(path: string, safeStorage: SecretStorage): unknown[] {
  if (!existsSync(path)) return []
  if (!safeStorage.decryptString) throw new Error("secure_storage_decrypt_unavailable")
  const parsed = JSON.parse(safeStorage.decryptString(readFileSync(path)))
  if (!Array.isArray(parsed)) throw new Error("password_vault_invalid")
  return parsed
}

export function createImportedCookie(row: Record<string, unknown>, value: string): ImportedCookie {
  const host = String(row.host_key ?? "")
  const secure = row.is_secure === 1
  const sameSite = chromeSameSite(row.samesite)
  return {
    url: `${secure ? "https" : "http"}://${host.replace(/^\./, "")}`,
    name: String(row.name ?? ""),
    value,
    path: String(row.path ?? "/"),
    ...(host.startsWith(".") ? { domain: host } : {}),
    ...(Number(row.expires_utc) > CHROME_EPOCH_US ? { expirationDate: (Number(row.expires_utc) - CHROME_EPOCH_US) / 1_000_000 } : {}),
    secure,
    httpOnly: row.is_httponly === 1,
    ...(sameSite ? { sameSite } : {}),
  }
}

export function discoverChromeProfiles(os = platform(), home = homedir()): ChromeImportProfile[] {
  if (os !== "win32" && os !== "darwin") return []
  const root = os === "win32" ? join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "Google", "Chrome", "User Data") : join(home, "Library", "Application Support", "Google", "Chrome")
  if (!existsSync(root)) return []
  let lastUsed = ""
  try { const localState = JSON.parse(readFileSync(join(root, "Local State"), "utf8")); if (typeof localState?.profile?.last_used === "string") lastUsed = localState.profile.last_used } catch { /* optional recency metadata */ }
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && (entry.name === "Default" || /^Profile \d+$/.test(entry.name))).sort((left, right) => Number(right.name === lastUsed) - Number(left.name === lastUsed)).flatMap((entry) => {
    const profilePath = join(root, entry.name)
    let name = entry.name
    try { const preferences = JSON.parse(readFileSync(join(profilePath, "Preferences"), "utf8")); if (typeof preferences?.profile?.name === "string" && preferences.profile.name.trim()) name = preferences.profile.name.trim() } catch { /* profile may be mid-update */ }
    const hasCookies = existsSync(join(profilePath, "Network", "Cookies")) || existsSync(join(profilePath, "Cookies"))
    const hasPasswords = existsSync(join(profilePath, "Login Data"))
    if (!hasCookies && !hasPasswords) return []
    return [{ id: createHash("sha256").update(profilePath).digest("hex").slice(0, 24), name, platform: os, hasCookies, hasPasswords }]
  })
}

export async function importChromeProfile(options: ImportOptions): Promise<ChromeImportReport> {
  if (!options.acknowledged) throw new Error("import_acknowledgement_required")
  const profiles = discoverChromeProfiles()
  const profile = profiles.find((item) => item.id === options.profileId)
  if (!profile) throw new Error("chrome_profile_not_found")
  const root = profile.platform === "win32" ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Google", "Chrome", "User Data") : join(homedir(), "Library", "Application Support", "Google", "Chrome")
  const directory = readdirSync(root, { withFileTypes: true }).find((entry) => entry.isDirectory() && createHash("sha256").update(join(root, entry.name)).digest("hex").startsWith(options.profileId))?.name
  if (!directory) throw new Error("chrome_profile_not_found")
  const source = join(root, directory)
  assertSafeChromeProfile(root, source)
  const report: ChromeImportReport = { imported: { cookies: 0, passwords: 0 }, skipped: { cookies: 0, passwords: 0 }, failed: { cookies: 0, passwords: 0 }, reasons: {}, errors: [], profileId: profile.id }
  const cookieRollbacks: Array<() => Promise<void>> = []
  const total = Number(options.cookies) + Number(options.passwords)
  let completed = 0
  const progress = (phase: string, counts: Record<string, unknown> = {}) => options.emit?.({ profileId: profile.id, phase, completed, total, ...counts })
  progress("snapshot")
  if (options.cookies && profile.hasCookies) {
    if (options.cancelled?.()) return cancelImport(report, cookieRollbacks)
    try {
      const rows = await readChromeCookieRows(join(source, existsSync(join(source, "Network", "Cookies")) ? "Network" : "", "Cookies"))
      const crypto = await chromeKey(profile.platform, source)
      for (const row of rows) {
        if (options.cancelled?.()) return cancelImport(report, cookieRollbacks)
        if (isPartitionedCookie(row)) {
          report.skipped.cookies += 1
          incrementReason(report, "partitioned_cookie_unsupported")
          continue
        }
        if (isExpiredChromeCookie(row)) {
          report.skipped.cookies += 1
          incrementReason(report, "expired_cookie")
          continue
        }
        const value = await decryptChromeValue(row.encrypted_value, crypto)
        if (!value || !options.onCookie) {
          report.skipped.cookies += 1
          incrementReason(report, encryptedValueVersion(row.encrypted_value) === "v20" ? "app_bound_cookie_unsupported" : "cookie_decrypt_unavailable")
          continue
        }
        try {
          const rollback = await options.onCookie(createImportedCookie(row, value))
          if (rollback) cookieRollbacks.push(rollback)
          report.imported.cookies += 1
        } catch { report.failed.cookies += 1 }
      }
      progress("cookies", { count: report.imported.cookies })
    } catch (error) { report.failed.cookies += 1; incrementReason(report, classifyChromeImportError(error)); report.errors.push("cookies_snapshot_or_decrypt_failed") }
  }
  completed += 1; progress("cookies")
  if (options.passwords && profile.hasPasswords) {
    if (options.cancelled?.()) return cancelImport(report, cookieRollbacks)
    try {
      const rows = await readChromeRows(join(source, "Login Data"));
      const crypto = await chromeKey(profile.platform, source)
      const safe = []
      for (const row of rows) {
        if (options.cancelled?.()) return cancelImport(report, cookieRollbacks)
        const secret = await decryptChromeValue(row.password_value, crypto)
        const origin = canonicalOrigin(row.origin_url)
        if (origin && row.username_value && secret) safe.push({ origin, username: String(row.username_value), secret })
        else report.skipped.passwords += 1
      }
      if (safe.length && options.safeStorage.isEncryptionAvailable()) {
        const vaultDir = join(options.configDir, "browser"); mkdirSync(vaultDir, { recursive: true }); const vault = join(vaultDir, "password-vault.json.enc")
        const old = readEncryptedVault(vault, options.safeStorage)
        const previous = old.filter((item): item is { origin: string; username: string; secret: string } => Boolean(item) && typeof item === "object" && typeof (item as { origin?: unknown }).origin === "string" && typeof (item as { username?: unknown }).username === "string" && typeof (item as { secret?: unknown }).secret === "string")
        const merged = mergeImportedPasswords(previous, safe)
        atomicWriteEncryptedVault(vault, merged, options.safeStorage)
      } else if (safe.length) {
        report.skipped.passwords += safe.length
      }
      if (safe.length && options.safeStorage.isEncryptionAvailable()) report.imported.passwords = safe.length
      progress("passwords", { count: report.imported.passwords, skipped: report.skipped.passwords })
    } catch (error) { report.failed.passwords += 1; incrementReason(report, classifyChromeImportError(error)); report.errors.push("passwords_snapshot_or_keychain_failed") }
  }
  completed += 1; progress("complete", report)
  writeImportMetadata(options.configDir, profile, report)
  return report
}

type SqliteReadDatabase = { prepare(sql: string): { all(): Record<string, unknown>[] }; close(): void }
type SqliteSourceDatabase = SqliteReadDatabase

export async function readChromeRows(path: string, query = "SELECT * FROM logins LIMIT 10000"): Promise<Record<string, unknown>[]> {
  return withChromeSnapshot(path, (db) => db.prepare(query).all())
}

export async function readChromeCookieRows(path: string): Promise<Record<string, unknown>[]> {
  return withChromeSnapshot(path, (db) => {
    const available = new Set(db.prepare("PRAGMA table_info(cookies)").all().map((column) => String(column.name)))
    const required = ["host_key", "name", "path", "encrypted_value", "expires_utc", "is_secure", "is_httponly"]
    if (required.some((column) => !available.has(column))) throw new Error("chrome_database_invalid")
    const optional = ["samesite", "source_scheme", "source_port", "top_frame_site_key", "is_partitioned", "has_cross_site_ancestor"].filter((column) => available.has(column))
    return db.prepare(`SELECT ${[...required, ...optional].join(",")} FROM cookies LIMIT 10000`).all()
  })
}

async function withChromeSnapshot<T>(path: string, read: (db: SqliteReadDatabase) => T): Promise<T> {
  if (!existsSync(path) || statSync(path).size > 512 * 1024 * 1024) throw new Error("chrome_database_invalid")
  const { DatabaseSync, backup } = runtimeRequire("node:sqlite") as {
    DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteSourceDatabase
    backup(source: SqliteSourceDatabase, path: string): Promise<void>
  }
  const temporaryDir = join(tmpdir(), `lume-browser-import-${process.pid}-${Date.now()}`)
  const snapshot = join(temporaryDir, "snapshot.sqlite")
  mkdirSync(temporaryDir, { recursive: true })
  try {
    const source = new DatabaseSync(path, { readOnly: true })
    try {
      let failure: unknown
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await backup(source, snapshot)
          failure = undefined
          break
        } catch (error) {
          failure = error
          rmSync(snapshot, { force: true })
          if (!/busy|locked/i.test(error instanceof Error ? error.message : String(error)) || attempt === 2) break
          await delay(25 * (2 ** attempt))
        }
      }
      if (failure) throw failure
    } finally { source.close() }
    const db = new DatabaseSync(snapshot, { readOnly: true })
    try { return read(db) } finally { db.close() }
  } finally { rmSync(temporaryDir, { recursive: true, force: true }) }
}

function chromeSameSite(value: unknown): ImportedCookie["sameSite"] | undefined {
  if (value === -1) return "unspecified"
  if (value === 0) return "no_restriction"
  if (value === 1) return "lax"
  if (value === 2) return "strict"
  return undefined
}

function isPartitionedCookie(row: Record<string, unknown>): boolean {
  return row.is_partitioned === 1 || (typeof row.top_frame_site_key === "string" && row.top_frame_site_key.length > 0)
}

export function isExpiredChromeCookie(row: Record<string, unknown>, now = Date.now()): boolean {
  const expires = Number(row.expires_utc)
  return Number.isFinite(expires) && expires > CHROME_EPOCH_US && expires <= CHROME_EPOCH_US + now * 1_000
}

function encryptedValueVersion(value: unknown): string {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : "")
  return bytes.subarray(0, 3).toString()
}

function incrementReason(report: ChromeImportReport, reason: string): void {
  report.reasons[reason] = (report.reasons[reason] ?? 0) + 1
}

async function cancelImport(report: ChromeImportReport, rollbacks: Array<() => Promise<void>>): Promise<ChromeImportReport> {
  for (const rollback of [...rollbacks].reverse()) await rollback().catch(() => undefined)
  report.imported.cookies = 0
  incrementReason(report, "cancelled_and_rolled_back")
  return report
}

function canonicalOrigin(value: unknown): string {
  try { const url = new URL(String(value)); return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "" } catch { return "" }
}

function writeImportMetadata(configDir: string, profile: ChromeImportProfile, report: ChromeImportReport): void {
  const directory = join(configDir, "browser")
  mkdirSync(directory, { recursive: true })
  const path = join(directory, "chrome-import-metadata.json")
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("import_metadata_symlink_rejected")
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, profileId: profile.id, profileName: profile.name, importedAt: new Date().toISOString(), imported: report.imported, skipped: report.skipped, failed: report.failed }), { mode: 0o600 })
  renameSync(temporary, path)
}

async function chromeKey(os: "win32" | "darwin", source: string): Promise<ChromeCryptoContext | null> {
  try {
    if (os === "darwin") {
      const { stdout } = await execFileAsync("security", ["find-generic-password", "-w", "-s", "Chrome Safe Storage"])
      const password = String(stdout).trim()
      return { platform: os, key: deriveMacChromeKey(password) }
    }
    const localState = JSON.parse(readFileSync(join(source, "..", "Local State"), "utf8"))
    const encrypted = Buffer.from(String(localState.os_crypt?.encrypted_key ?? ""), "base64")
    if (!encrypted.subarray(0, 5).equals(Buffer.from("DPAPI"))) return null
    const unprotect = async (value: Buffer): Promise<Buffer | null> => {
      try {
        const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$b=[Convert]::FromBase64String($args[0]);$d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Convert]::ToBase64String($d)", value.toString("base64")])
        return Buffer.from(String(stdout).trim(), "base64")
      } catch { return null }
    }
    return { platform: os, key: await unprotect(encrypted.subarray(5)), unprotect }
  } catch { return null }
}

export async function decryptChromeValue(value: unknown, context: ChromeCryptoContext | null): Promise<string | null> {
  if (!value) return null
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "base64")
  if (bytes.subarray(0, 3).toString() === "v20") return null
  try {
    if (context?.platform === "win32") {
      if (bytes.subarray(0, 3).toString() === "v10" || bytes.subarray(0, 3).toString() === "v11") return context.key ? decryptWindowsV10Value(bytes, context.key) : null
      return context.unprotect ? (await context.unprotect(bytes))?.toString("utf8") ?? null : null
    }
    return context?.platform === "darwin" && context.key ? decryptMacV10Value(bytes, context.key) : null
  } catch { return null }
}

function assertSafeChromeProfile(root: string, profile: string): void {
  for (const path of [root, profile, join(profile, "Login Data"), join(profile, "Network", "Cookies")]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("chrome_profile_link_rejected")
  }
  const canonicalRoot = realpathSync(root)
  const canonicalProfile = realpathSync(profile)
  if (canonicalProfile !== canonicalRoot && !canonicalProfile.startsWith(canonicalRoot + "/") && !canonicalProfile.startsWith(canonicalRoot + "\\")) throw new Error("chrome_profile_escape")
}
