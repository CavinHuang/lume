import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectVerificationCommands,
  selectVerificationCommandsForWorkspaces,
} from "./coding-verification";

const roots: string[] = [];

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "lume-verification-"));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("coding verification command selection", () => {
  test("prefers existing check/typecheck scripts and caps suggestions at two", () => {
    const root = makeTempDir();
    roots.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { check: "bun test", typecheck: "tsc", test: "bun test", lint: "eslint ." } }), "utf8");

    expect(selectVerificationCommands({ workspaceRoot: root, changedFiles: ["src/main.ts"] }).map((item) => item.command)).toEqual([
      "bun run check",
      "bun run typecheck",
    ]);
  });

  test("uses a test script when a test file changed", () => {
    const root = makeTempDir();
    roots.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc", test: "bun test", lint: "eslint ." } }), "utf8");

    expect(selectVerificationCommands({ workspaceRoot: root, changedFiles: ["src/main.test.ts"] })[0]?.script).toBe("typecheck");
    expect(selectVerificationCommands({ workspaceRoot: root, changedFiles: ["src/main.test.ts"] }).map((item) => item.script)).toContain("test");
  });

  test("does not invent commands for a repository without scripts", () => {
    const root = makeTempDir();
    roots.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "empty" }), "utf8");

    expect(selectVerificationCommands({ workspaceRoot: root, changedFiles: ["README.md"] })).toEqual([]);
  });

  test("selects at least one explicit command for every changed workspace", () => {
    const first = makeTempDir();
    const second = makeTempDir();
    roots.push(first, second);
    writeFileSync(join(first, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }), "utf8");
    writeFileSync(join(second, "go.mod"), "module example.com/second\n\ngo 1.22\n", "utf8");

    const commands = selectVerificationCommandsForWorkspaces([
      { workspaceRoot: first, rootId: "first", changedFiles: ["src/main.ts"] },
      { workspaceRoot: second, rootId: "second", changedFiles: ["main.go"] },
    ]);

    expect(commands.map((item) => item.rootId)).toEqual(["first", "second"]);
    expect(commands[0]?.command).toContain(first);
    expect(commands[1]?.command).toBe(`go -C ${second} test ./...`);
  });

  test("discovers configured Python, Rust and dotnet verification commands", () => {
    const python = makeTempDir();
    const rust = makeTempDir();
    const dotnet = makeTempDir();
    roots.push(python, rust, dotnet);
    writeFileSync(join(python, "pyproject.toml"), "[tool.pytest.ini_options]\n", "utf8");
    writeFileSync(join(rust, "Cargo.toml"), "[package]\nname='demo'\nversion='0.1.0'\n", "utf8");
    writeFileSync(join(dotnet, "Demo.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\" />", "utf8");
    mkdirSync(join(python, "tests"));

    expect(selectVerificationCommands({
      workspaceRoot: python,
      changedFiles: ["tests/test_demo.py"],
    }).map((item) => item.script)).toContain("pytest");
    expect(selectVerificationCommands({
      workspaceRoot: rust,
      changedFiles: ["src/lib.rs"],
    })[0]?.script).toBe("cargo:check");
    expect(selectVerificationCommands({
      workspaceRoot: dotnet,
      changedFiles: ["Program.cs"],
    })[0]?.command).toContain("dotnet test");
  });
});
