import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BrowserCredentialVault } from "../src/browser-credentials.ts";
import { atomicWriteEncryptedVault } from "../src/browser-import.ts";

const storage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value).toString("base64"), decryptString: (value) => Buffer.from(value.toString(), "base64").toString() };

test("contact vault exposes metadata while values remain encrypted at rest", () => {
  const root = join(process.cwd(), ".tmp-browser-credentials-test");
  const vault = new BrowserCredentialVault(() => root, storage);
  try {
    const metadata = vault.upsertContact({ label: "Home", email: "secret@example.test", phone: "123" });
    assert.deepEqual(metadata.fields, ["email", "phone"]);
    assert.equal(vault.listContacts()[0].label, "Home");
    assert.equal(vault.contactValue(metadata.id, "email"), "secret@example.test");
    assert.equal(readFileSync(join(root, "browser", "contact-vault.json.enc"), "utf8").includes("secret@example.test"), false);
    assert.equal(vault.deleteContact(metadata.id), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("password lookup is bound to canonical origin and returns no secret metadata", () => {
  const root = join(process.cwd(), ".tmp-browser-password-metadata-test");
  const vaultPath = join(root, "browser", "password-vault.json.enc");
  const vault = new BrowserCredentialVault(() => root, storage);
  try {
    atomicWriteEncryptedVault(vaultPath, [{ origin: "https://example.test/login", username: "user", secret: "password" }], storage);
    const metadata = vault.listPasswords()[0];
    assert.equal("secret" in metadata, false);
    assert.equal(vault.passwordForOrigin(metadata.id, "https://example.test/account"), "password");
    assert.equal(vault.passwordForOrigin(metadata.id, "https://other.test"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
