import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SOURCE_ROOT = resolve(import.meta.dir, "../..");
const DIRECT_CONSOLE_CALL = /\bconsole\.(?:log|info|warn|error|debug)\s*\(/g;

function listRuntimeTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listRuntimeTypeScriptFiles(path);
    if (!entry.isFile() || !entry.name.endsWith(".ts")) return [];
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".bench.ts")) return [];
    return [path];
  });
}

describe("logging source contract", () => {
  test("first-party sidecar runtime does not call console directly", () => {
    const violations = listRuntimeTypeScriptFiles(SOURCE_ROOT).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      const matches = [...source.matchAll(DIRECT_CONSOLE_CALL)];
      return matches.map((match) => `${relative(SOURCE_ROOT, path)}:${source.slice(0, match.index).split(/\r?\n/).length}`);
    });
    expect(violations).toEqual([]);
  });
});
