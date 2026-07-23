import assert from "node:assert/strict";
import test from "node:test";
import { createCipheriv } from "node:crypto";
import { discoverChromeProfiles, mergeImportedPasswords, classifyChromeImportError, decryptWindowsV10Value, deriveMacChromeKey, decryptMacV10Value, decryptLegacyDpapiValue, atomicWriteEncryptedVault, createImportedCookie, readEncryptedVault, readChromeRows, readChromeCookieRows, isExpiredChromeCookie } from "../src/browser-import.ts";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

test("Chrome discovery exposes only non-secret profile metadata", () => {
  const root = join(process.cwd(), ".tmp-browser-import-test");
  const chromeRoot = join(root, "Library", "Application Support", "Google", "Chrome");
  const profile = join(chromeRoot, "Profile 1");
  mkdirSync(profile, { recursive: true });
  mkdirSync(join(chromeRoot, "Default"), { recursive: true });
  writeFileSync(join(chromeRoot, "Default", "Login Data"), "placeholder");
  writeFileSync(join(chromeRoot, "Local State"), JSON.stringify({ profile: { last_used: "Profile 1" } }));
  writeFileSync(join(profile, "Preferences"), JSON.stringify({ profile: { name: "Work" } }));
  writeFileSync(join(profile, "Login Data"), "placeholder");
  const found = discoverChromeProfiles("darwin", root);
  assert.equal(found[0].name, "Work");
  assert.equal(found.length, 2);
  rmSync(root, { recursive: true, force: true });
});

test("password merge replaces the selected origin and username only", () => {
  assert.deepEqual(mergeImportedPasswords([{ origin: "https://a", username: "u", secret: "old" }], [{ origin: "https://a", username: "u", secret: "new" }, { origin: "https://b", username: "u", secret: "b" }]), [{ origin: "https://a", username: "u", secret: "new" }, { origin: "https://b", username: "u", secret: "b" }]);
});

test("import errors classify security and rollback boundaries", () => {
  assert.equal(classifyChromeImportError(new Error("v20 app-bound encryption")), "app_bound_unsupported");
  assert.equal(classifyChromeImportError(new Error("keychain denied")), "keychain_denied");
  assert.equal(classifyChromeImportError(new Error("database busy")), "database_locked");
});

test("Windows v10 uses AES-256-GCM and macOS legacy values use Chrome AES-CBC", () => {
  const windowsKey = Buffer.alloc(32, 7);
  const nonce = Buffer.alloc(12, 8);
  const cipher = createCipheriv("aes-256-gcm", windowsKey, nonce);
  const encrypted = Buffer.concat([cipher.update("cookie-secret", "utf8"), cipher.final()]);
  const windowsValue = Buffer.concat([Buffer.from("v10"), nonce, encrypted, cipher.getAuthTag()]);
  assert.equal(decryptWindowsV10Value(windowsValue, windowsKey), "cookie-secret");

  const macKey = deriveMacChromeKey("correct horse battery staple");
  const macCipher = createCipheriv("aes-128-cbc", macKey, Buffer.alloc(16, " "));
  const macValue = Buffer.concat([Buffer.from("v10"), macCipher.update("legacy-password", "utf8"), macCipher.final()]);
  assert.equal(decryptMacV10Value(macValue, macKey), "legacy-password");
  assert.equal(decryptLegacyDpapiValue(Buffer.from("raw"), (value) => Buffer.from(value.toString().toUpperCase())), "RAW");
});

test("encrypted vault writes are replaceable and leave no plaintext secret", () => {
  const root = join(process.cwd(), ".tmp-browser-vault-test");
  const vault = join(root, "vault.enc");
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value, "utf8").toString("base64"), decryptString: (value) => Buffer.from(value.toString("utf8"), "base64").toString("utf8") };
  atomicWriteEncryptedVault(vault, [{ origin: "https://example.test", username: "u", secret: "password" }], safeStorage);
  assert.equal(readFileSync(vault, "utf8").includes("password"), false);
  assert.equal(existsSync(`${vault}.bak`), false);
  rmSync(root, { recursive: true, force: true });
});

test("cookie import preserves Chrome domain scope but keeps host-only cookies host-only", () => {
  const domainCookie = createImportedCookie({ host_key: ".example.test", name: "sid", path: "/", is_secure: 1, is_httponly: 1, samesite: 2 }, "secret");
  assert.equal(domainCookie.url, "https://example.test");
  assert.equal(domainCookie.domain, ".example.test");
  assert.equal(domainCookie.sameSite, "strict");
  const hostCookie = createImportedCookie({ host_key: "login.example.test", name: "sid", path: "/", is_secure: 1, is_httponly: 1 }, "secret");
  assert.equal("domain" in hostCookie, false);
});

test("expired persistent cookies are skipped instead of widening into session cookies", () => {
  const chromeEpoch = 11644473600000000;
  assert.equal(isExpiredChromeCookie({ expires_utc: chromeEpoch + 999_000 }, 1_000), true);
  assert.equal(isExpiredChromeCookie({ expires_utc: 0 }, 1_000), false);
  assert.equal(isExpiredChromeCookie({ expires_utc: chromeEpoch + 1_001_000 }, 1_000), false);
});

test("online backup reads committed rows from an active WAL database", { skip: Boolean(process.versions.bun) }, async () => {
  const { DatabaseSync } = await import(["node", "sqlite"].join(":"));
  const root = join(process.cwd(), ".tmp-browser-wal-test");
  const source = join(root, "Cookies");
  mkdirSync(root, { recursive: true });
  const writer = new DatabaseSync(source);
  try {
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('visible-in-wal')");
    const rows = await readChromeRows(source, "SELECT value FROM sample");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].value, "visible-in-wal");
  } finally {
    writer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cookie snapshots include partition and SameSite columns when Chrome provides them", { skip: Boolean(process.versions.bun) }, async () => {
  const { DatabaseSync } = await import(["node", "sqlite"].join(":"));
  const root = join(process.cwd(), ".tmp-browser-cookie-schema-test");
  const source = join(root, "Cookies");
  mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(source);
  try {
    db.exec("CREATE TABLE cookies(host_key TEXT,name TEXT,path TEXT,encrypted_value BLOB,expires_utc INTEGER,is_secure INTEGER,is_httponly INTEGER,samesite INTEGER,top_frame_site_key TEXT); INSERT INTO cookies VALUES ('example.test','sid','/',X'763130',0,1,1,1,'https://top.test')");
  } finally { db.close(); }
  try {
    const rows = await readChromeCookieRows(source);
    assert.equal(rows[0].samesite, 1);
    assert.equal(rows[0].top_frame_site_key, "https://top.test");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unreadable existing vault is never treated as an empty vault", () => {
  const root = join(process.cwd(), ".tmp-browser-vault-corrupt-test");
  const vault = join(root, "vault.enc");
  mkdirSync(root, { recursive: true });
  writeFileSync(vault, "corrupt");
  assert.throws(() => readEncryptedVault(vault, { isEncryptionAvailable: () => true, encryptString: Buffer.from, decryptString: () => { throw new Error("decrypt failed"); } }), /decrypt failed/);
  assert.equal(readFileSync(vault, "utf8"), "corrupt");
  rmSync(root, { recursive: true, force: true });
});
