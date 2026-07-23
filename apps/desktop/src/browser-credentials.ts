import { createHash, randomUUID } from "node:crypto"
import { join } from "node:path"
import { atomicWriteEncryptedVault, readEncryptedVault } from "./browser-import"

type SecretStorage = { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString?(value: Buffer): string }
type PasswordRecord = { origin: string; username: string; secret: string }
type ContactRecord = { id: string; label: string; name?: string; email?: string; phone?: string; address?: string }
export type PasswordMetadata = { id: string; origin: string; username: string }
export type ContactMetadata = { id: string; label: string; fields: Array<"name" | "email" | "phone" | "address"> }

export class BrowserCredentialVault {
  constructor(private readonly configDir: () => string, private readonly storage: SecretStorage) {}

  passwordSummary(): { passwordEntries: number; encrypted: boolean } {
    return { passwordEntries: this.passwords().length, encrypted: this.storage.isEncryptionAvailable() }
  }

  listPasswords(): PasswordMetadata[] {
    return this.passwords().map((record) => ({ id: passwordId(record.origin, record.username), origin: canonicalOrigin(record.origin), username: record.username }))
  }

  passwordForOrigin(id: string, origin: string): string | null {
    const canonical = canonicalOrigin(origin)
    const record = this.passwords().find((candidate) => passwordId(candidate.origin, candidate.username) === id && canonicalOrigin(candidate.origin) === canonical)
    return record?.secret ?? null
  }

  deletePassword(id: string): boolean {
    const records = this.passwords()
    const next = records.filter((record) => passwordId(record.origin, record.username) !== id)
    if (next.length === records.length) return false
    atomicWriteEncryptedVault(this.passwordPath(), next, this.storage)
    return true
  }

  listContacts(): ContactMetadata[] {
    return this.contacts().map((record) => ({ id: record.id, label: record.label, fields: contactFields(record) }))
  }

  upsertContact(input: Record<string, unknown>): ContactMetadata {
    const id = typeof input.id === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(input.id) ? input.id : randomUUID()
    const label = boundedText(input.label, 80)
    if (!label) throw new Error("invalid_contact")
    const record: ContactRecord = {
      id,
      label,
      ...(boundedText(input.name, 200) ? { name: boundedText(input.name, 200) } : {}),
      ...(boundedText(input.email, 320) ? { email: boundedText(input.email, 320) } : {}),
      ...(boundedText(input.phone, 80) ? { phone: boundedText(input.phone, 80) } : {}),
      ...(boundedText(input.address, 500) ? { address: boundedText(input.address, 500) } : {}),
    }
    const records = this.contacts().filter((candidate) => candidate.id !== id)
    atomicWriteEncryptedVault(this.contactPath(), [...records, record], this.storage)
    return { id, label, fields: contactFields(record) }
  }

  deleteContact(id: string): boolean {
    const records = this.contacts()
    const next = records.filter((record) => record.id !== id)
    if (next.length === records.length) return false
    atomicWriteEncryptedVault(this.contactPath(), next, this.storage)
    return true
  }

  contactValue(id: string, field: string): string | null {
    if (!(["name", "email", "phone", "address"] as string[]).includes(field)) return null
    const value = this.contacts().find((record) => record.id === id)?.[field as keyof Pick<ContactRecord, "name" | "email" | "phone" | "address">]
    return typeof value === "string" ? value : null
  }

  clearPasswords(): void { atomicWriteEncryptedVault(this.passwordPath(), [], this.storage) }

  private passwords(): PasswordRecord[] {
    return readEncryptedVault(this.passwordPath(), this.storage).filter(isPasswordRecord)
  }

  private contacts(): ContactRecord[] {
    return readEncryptedVault(this.contactPath(), this.storage).filter(isContactRecord)
  }

  private passwordPath(): string { return join(this.configDir(), "browser", "password-vault.json.enc") }
  private contactPath(): string { return join(this.configDir(), "browser", "contact-vault.json.enc") }
}

function passwordId(origin: string, username: string): string { return createHash("sha256").update(`${canonicalOrigin(origin)}\0${username}`).digest("base64url").slice(0, 32) }
function canonicalOrigin(value: string): string { try { return new URL(value).origin } catch { return "" } }
function boundedText(value: unknown, length: number): string { return typeof value === "string" ? value.trim().slice(0, length) : "" }
function contactFields(record: ContactRecord): ContactMetadata["fields"] { return (["name", "email", "phone", "address"] as const).filter((field) => Boolean(record[field])) }
function isPasswordRecord(value: unknown): value is PasswordRecord { return Boolean(value) && typeof value === "object" && typeof (value as PasswordRecord).origin === "string" && typeof (value as PasswordRecord).username === "string" && typeof (value as PasswordRecord).secret === "string" }
function isContactRecord(value: unknown): value is ContactRecord { return Boolean(value) && typeof value === "object" && typeof (value as ContactRecord).id === "string" && typeof (value as ContactRecord).label === "string" }
