import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  deleteConnectionApiKey,
  deleteConnectionOAuthCredential,
  getConnectionApiKey,
  getConnectionOAuthCredential,
  installConnectionVaultKey,
  setConnectionApiKey,
  setConnectionOAuthCredential,
} from "./connection-credential-store";

describe("connection credential store", () => {
  let previousConfigDir: string | undefined;
  let directory = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    directory = mkdtempSync(join(tmpdir(), "lume-connection-credentials-"));
    process.env.LUME_CONFIG_DIR = directory;
    installConnectionVaultKey(Buffer.alloc(32, 11).toString("base64"));
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = previousConfigDir;
    rmSync(directory, { recursive: true, force: true });
  });

  test("encrypts API keys and OAuth credentials outside channels.json", () => {
    setConnectionApiKey("connection-1", "sk-secret-value");
    setConnectionOAuthCredential("connection-1", {
      type: "oauth",
      access: "access-secret",
      refresh: "refresh-secret",
      expires: Date.now() + 60_000,
    });

    expect(getConnectionApiKey("connection-1")).toBe("sk-secret-value");
    expect(getConnectionOAuthCredential("connection-1")).toMatchObject({
      access: "access-secret",
      refresh: "refresh-secret",
    });
    const persisted = readFileSync(join(directory, "connection-credentials.json"), "utf8");
    expect(persisted).not.toContain("sk-secret-value");
    expect(persisted).not.toContain("access-secret");
    expect(persisted).not.toContain("refresh-secret");
  });

  test("removes one authentication method without deleting the other", () => {
    setConnectionApiKey("connection-1", "sk-secret-value");
    setConnectionOAuthCredential("connection-1", {
      type: "oauth",
      access: "access-secret",
      refresh: "refresh-secret",
      expires: Date.now() + 60_000,
    });

    deleteConnectionApiKey("connection-1");
    expect(getConnectionApiKey("connection-1")).toBe("");
    expect(getConnectionOAuthCredential("connection-1")?.access).toBe("access-secret");

    deleteConnectionOAuthCredential("connection-1");
    expect(getConnectionOAuthCredential("connection-1")).toBeUndefined();
  });
});
