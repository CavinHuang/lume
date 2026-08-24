import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  resolveConfiguredPermissionRules,
  resolveConfiguredPrivateWriteRoots
} from "./permission-config";

describe("permission config adapter", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-permission-config-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    rmSync(tempConfigDir, { recursive: true, force: true });
  });

  test("resolves only explicit permission rules", () => {
    expect(resolveConfiguredPermissionRules({
      rules: [{ id: "explicit-ask", tool: "Write", action: "ask" }],
      toolPolicy: {
        allow: ["Read"],
        deny: ["Bash"]
      }
    })).toEqual([
      { id: "explicit-ask", tool: "Write", action: "ask" }
    ]);
  });

  test("resolves private write roots for thread, workspace, skills, and plugins", () => {
    const agentCwd = join(tempConfigDir, "thread");
    const roots = resolveConfiguredPrivateWriteRoots({
      agentCwd,
      workspaceSlug: "demo",
      configuredRoots: ["custom-private"]
    });

    expect(roots).toContain(resolve(agentCwd, ".lume"));
    expect(roots).toContain(resolve(agentCwd, "plans"));
    expect(roots).toContain(resolve(agentCwd, "artifacts"));
    expect(roots).toContain(resolve(agentCwd, "files"));
    expect(roots).toContain(join(tempConfigDir, "default-skills"));
    expect(roots).toContain(join(tempConfigDir, "skills"));
    expect(roots).toContain(join(tempConfigDir, "agent-workspaces", "demo", "skills"));
    expect(roots).toContain(join(homedir(), ".lume", "plugins"));
    expect(roots).toContain(resolve(agentCwd, "custom-private"));
  });
});
