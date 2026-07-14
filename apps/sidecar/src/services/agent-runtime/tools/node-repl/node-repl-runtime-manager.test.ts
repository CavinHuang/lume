import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { buildNodeReplChildEnv } from "./node-repl-runtime-manager";

describe("node_repl trusted Computer Use runtime", () => {
  test("grants computerUse only when the bundled trusted client exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-node-repl-computer-use-"));
    try {
      const client = join(root, "computer-use", "scripts", "computer-use-client.mjs");
      await mkdir(join(root, "computer-use", "scripts"), { recursive: true });
      await writeFile(client, "export const ready = true", "utf8");

      const enabled = buildNodeReplChildEnv({
        BASE: "value",
        LUME_BUNDLED_PLUGINS_DIR: root,
      });
      expect(JSON.parse(enabled.LUME_CUA_RUNTIME_MANIFEST!)).toMatchObject({
        permissions: ["computerUse"],
      });
      expect(enabled.NODE_REPL_TRUSTED_CODE_PATHS).toBe(client);

      const disabled = buildNodeReplChildEnv({ BASE: "value" });
      expect(disabled.LUME_CUA_RUNTIME_MANIFEST).toBeUndefined();
      expect(disabled.NODE_REPL_TRUSTED_CODE_PATHS).toBeUndefined();

      const existingClient = join(root, "browser-client.mjs");
      const merged = buildNodeReplChildEnv({
        LUME_BUNDLED_PLUGINS_DIR: root,
        LUME_CUA_RUNTIME_MANIFEST: JSON.stringify({
          name: "existing-runtime",
          permissions: ["browser"],
          allowedModules: ["node:path"],
        }),
        NODE_REPL_TRUSTED_CODE_PATHS: existingClient,
      });
      expect(JSON.parse(merged.LUME_CUA_RUNTIME_MANIFEST!)).toMatchObject({
        name: "existing-runtime",
        permissions: ["browser", "computerUse"],
        allowedModules: ["node:path"],
      });
      expect(merged.NODE_REPL_TRUSTED_CODE_PATHS?.split(delimiter)).toEqual([
        existingClient,
        client,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
