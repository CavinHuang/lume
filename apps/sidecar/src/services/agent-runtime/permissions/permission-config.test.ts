import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
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
      rules: [{ id: "explicit-ask", tool: "Write", action: "ask", scope: "global" }],
      toolPolicy: {
        allow: ["Read"],
        deny: ["Bash"]
      }
    })).toEqual([
      { id: "explicit-ask", tool: "Write", action: "ask", scope: "global" }
    ]);
  });

  test("resolves private write roots for thread, workspace, skills, and plugins", () => {
    const roots = resolveConfiguredPrivateWriteRoots({
      agentCwd: "/tmp/thread",
      workspaceSlug: "demo",
      configuredRoots: ["custom-private"]
    });

    expect(roots).toContain("/tmp/thread/.lume");
    expect(roots).toContain("/tmp/thread/plans");
    expect(roots).toContain("/tmp/thread/artifacts");
    expect(roots).toContain("/tmp/thread/files");
    expect(roots).toContain(join(tempConfigDir, "default-skills"));
    expect(roots).toContain(join(tempConfigDir, "skills"));
    expect(roots).toContain(join(tempConfigDir, "agent-workspaces", "demo", "skills"));
    expect(roots).toContain(join(homedir(), ".lume", "plugins"));
    expect(roots).toContain("/tmp/thread/custom-private");
  });
});
