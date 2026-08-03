import { createHash } from "node:crypto"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import {
  classifyChromeImportError,
  chromeEncryptedBytes,
  discoverChromeProfiles,
  readChromeCookieRows,
  readChromeRows,
} from "../src/browser-import.ts"

if (process.platform !== "win32") throw new Error("The live Chrome import smoke currently supports Windows only")

const chromeRunning = spawnSync("tasklist", ["/FI", "IMAGENAME eq chrome.exe", "/FO", "CSV", "/NH"], {
  encoding: "utf8",
  windowsHide: true,
}).stdout.includes("chrome.exe")
if (!chromeRunning) throw new Error("Chrome must remain open during the live import compatibility smoke")

const root = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Google", "Chrome", "User Data")
const profiles = discoverChromeProfiles()
const results = []

for (const profile of profiles) {
  const directory = readdirSync(root, { withFileTypes: true }).find((entry) =>
    entry.isDirectory()
    && createHash("sha256").update(join(root, entry.name)).digest("hex").startsWith(profile.id)
  )?.name
  if (!directory) continue
  const profileRoot = join(root, directory)
  const result = {
    profileId: profile.id,
    cookies: { readable: false, rows: 0, versions: {} },
    passwords: { readable: false, rows: 0, versions: {} },
    errors: [],
  }
  const cookiePath = join(profileRoot, existsSync(join(profileRoot, "Network", "Cookies")) ? "Network" : "", "Cookies")
  if (profile.hasCookies) {
    try {
      const rows = await readChromeCookieRows(cookiePath)
      result.cookies = { readable: true, rows: rows.length, versions: countEncryptedVersions(rows, "encrypted_value") }
    } catch (error) {
      result.errors.push(`cookies:${classifyChromeImportError(error)}`)
    }
  }
  if (profile.hasPasswords) {
    try {
      const rows = await readChromeRows(join(profileRoot, "Login Data"), "SELECT password_value FROM logins LIMIT 10000")
      result.passwords = { readable: true, rows: rows.length, versions: countEncryptedVersions(rows, "password_value") }
    } catch (error) {
      result.errors.push(`passwords:${classifyChromeImportError(error)}`)
    }
  }
  results.push(result)
}

if (profiles.length === 0) throw new Error("No current Chrome profiles were discovered")
if (!results.some((result) => result.cookies.readable || result.passwords.readable)) {
  throw new Error("No current Chrome database could be read through an online backup")
}
console.log(JSON.stringify({ ok: true, chromeRunning, profileCount: profiles.length, profiles: results }))

function countEncryptedVersions(rows, field) {
  const counts = {}
  for (const row of rows) {
    const bytes = chromeEncryptedBytes(row[field])
    const prefix = bytes.subarray(0, 3).toString()
    const version = prefix === "v20" || prefix === "v10" || prefix === "v11"
      ? prefix
      : bytes.length > 0 ? "legacy" : "empty"
    counts[version] = (counts[version] ?? 0) + 1
  }
  return counts
}
