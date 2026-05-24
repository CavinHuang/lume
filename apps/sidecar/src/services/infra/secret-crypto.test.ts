import { describe, expect, test } from "bun:test";
import { decryptSecret, encryptSecret } from "./secret-crypto";

describe("secret-crypto", () => {
  test("encryptSecret round-trips without returning plaintext", () => {
    const encrypted = encryptSecret("secret-value");

    expect(encrypted).not.toBe("secret-value");
    expect(decryptSecret(encrypted)).toBe("secret-value");
  });
});
