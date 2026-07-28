import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { selectVerificationCommands } from "./coding-verification";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("coding verification command selection", () => {
  test("prefers existing check/typecheck scripts and caps suggestions at two", () => {
    const root = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "lume-verification-"));
    roots.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { check: "bun test", typecheck: "tsc", test: "bun test", lint: "eslint ." } }), "utf8");

    expect(selectVerificationCommands({ workspaceRoot: root, changedFiles: ["src/main.ts"] }).map((item) => item.command)).toEqual([
      "bun run check",
      "bun run typecheck",
    ]);
  });

  test("uses a test script when a test file changed", () => {
    const root = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "lume-verification-"));
    roots.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc", test: "bun test", lint: "eslint ." } }), "utf8");

    expect(selectVerificationCommands({ workspaceRoot: root, changedFiles: ["src/main.test.ts"] })[0]?.script).toBe("typecheck");
    expect(selectVerificationCommands({ workspaceRoot: root, changedFiles: ["src/main.test.ts"] }).map((item) => item.script)).toContain("test");
  });

  test("does not invent commands for a repository without scripts", () => {
    const root = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "lume-verification-"));
    roots.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "empty" }), "utf8");

    expect(selectVerificationCommands({ workspaceRoot: root, changedFiles: ["README.md"] })).toEqual([]);
  });
});
