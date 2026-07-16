import { createHmac, randomBytes } from "node:crypto";
import type { LumeLogDigestPolicy } from "@lume/shared";

let policy: LumeLogDigestPolicy = {
  schemaVersion: 1,
  algorithm: "hmac-sha256",
  keyVersion: 1,
  scope: "session",
  key: randomBytes(32).toString("base64")
};

export function setLogDigestPolicy(input: LumeLogDigestPolicy): void {
  if (
    input?.schemaVersion !== 1
    || input.algorithm !== "hmac-sha256"
    || !Number.isSafeInteger(input.keyVersion)
    || input.keyVersion < 1
    || (input.scope !== "install" && input.scope !== "session")
  ) {
    throw new Error("invalid log digest policy");
  }
  const key = Buffer.from(input.key, "base64");
  if (key.length !== 32 || key.toString("base64") !== input.key) {
    throw new Error("invalid log digest key");
  }
  policy = { ...input };
}

export function createLogContentDigest(content: string, purpose: string): {
  digest: string;
  algorithm: "hmac-sha256";
  keyVersion: number;
  scope: "install" | "session";
} {
  const key = Buffer.from(policy.key, "base64");
  try {
    return {
      digest: createHmac("sha256", key).update(purpose, "utf8").update("\0").update(content, "utf8").digest("hex"),
      algorithm: policy.algorithm,
      keyVersion: policy.keyVersion,
      scope: policy.scope
    };
  } finally {
    key.fill(0);
  }
}
