import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { readdir } from "fs/promises";
import { basename, dirname, join } from "path";
import { tmpdir } from "os";
import {
  analyzeSkillImprovement,
  applySkillImprovement,
  listSkillVersions,
  recordSkillUsage,
  restoreSkillVersion,
} from "./evolution";
import { withFileMutationLock } from "../utils/file-mutation-lock";

function makeSkillFile(content = "# Demo Skill\n\nUse carefully.") {
  const root = join(tmpdir(), `sdk-skill-evolution-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const skillDir = join(root, "demo");
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(skillPath, content, "utf-8");
  return { root, skillDir, skillPath };
}

describe("skill evolution", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recordSkillUsage appends usage.jsonl and throttles duplicate skill hits for one hour", async () => {
    const { root, skillDir, skillPath } = makeSkillFile();
    roots.push(root);

    await recordSkillUsage({ skillName: "demo", skillPath, sessionId: "thread-1", now: 1000 });
    await recordSkillUsage({ skillName: "demo", skillPath, sessionId: "thread-1", now: 30_000 });
    await recordSkillUsage({ skillName: "demo", skillPath, sessionId: "thread-2", now: 61_000 });
    await recordSkillUsage({ skillName: "demo", skillPath, sessionId: "thread-3", now: 3_601_000 });

    const lines = readFileSync(join(skillDir, "usage.jsonl"), "utf-8").trim().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { ts: 1000, sessionId: "thread-1" },
      { ts: 3_601_000, sessionId: "thread-3" },
    ]);
  });

  test("analyzeSkillImprovement parses model updates from recent user and assistant messages", async () => {
    const updates = await analyzeSkillImprovement({
      skillContent: "# Demo",
      messages: [
        { role: "system", content: "ignored" },
        { role: "user", content: "Please make this stricter" },
        { role: "assistant", content: [{ type: "text", text: "I missed a validation step" }] },
      ],
      callModel: async ({ userPrompt }) => {
        expect(userPrompt).toContain("# Demo");
        expect(userPrompt).toContain("Please make this stricter");
        expect(userPrompt).toContain("I missed a validation step");
        return '<updates>[{"section":"Validation","change":"Require dry run first","reason":"A prior run skipped validation"}]</updates>';
      },
    });

    expect(updates).toEqual([
      {
        section: "Validation",
        change: "Require dry run first",
        reason: "A prior run skipped validation",
      },
    ]);
  });

  test("applySkillImprovement backs up current content, writes model-updated content, and lists versions", async () => {
    const { root, skillPath } = makeSkillFile("# Demo Skill\n\nOld rule.");
    roots.push(root);

    const result = await applySkillImprovement({
      skillPath,
      updates: [{ section: "Rules", change: "Use the new rule", reason: "Observed failures" }],
      callModel: async ({ currentContent, updateList }) => {
        expect(currentContent).toContain("Old rule.");
        expect(updateList).toContain("- Rules: Use the new rule");
        return "<updated_file># Demo Skill\n\nNew rule.</updated_file>";
      },
    });

    expect(result.success).toBe(true);
    expect(readFileSync(skillPath, "utf-8")).toBe("# Demo Skill\n\nNew rule.");
    expect(dirname(result.versionPath!)).toBe(join(dirname(skillPath), "versions"));
    expect(basename(result.versionPath!)).toMatch(/^\d{4}-\d{2}-\d{2}_\d{6}_[a-f0-9]{8}\.md$/);
    expect(existsSync(result.versionPath!)).toBe(true);

    const versions = await listSkillVersions(skillPath);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.path).toBe(result.versionPath);
  });

  test("restoreSkillVersion backs up current content before restoring a listed version", async () => {
    const { root, skillPath } = makeSkillFile("# Demo Skill\n\nOriginal.");
    roots.push(root);
    const applied = await applySkillImprovement({
      skillPath,
      updates: [{ section: "Rules", change: "Use changed content", reason: "Test" }],
      callModel: async () => "<updated_file># Demo Skill\n\nChanged.</updated_file>",
    });

    const restored = await restoreSkillVersion({
      skillPath,
      filename: applied.versionPath!.split("/").pop()!,
    });

    expect(restored.success).toBe(true);
    expect(readFileSync(skillPath, "utf-8")).toBe("# Demo Skill\n\nOriginal.");
    const versionFiles = await readdir(join(dirname(skillPath), "versions"));
    expect(versionFiles.filter((file) => /^\d{4}-\d{2}-\d{2}_\d{6}_[a-f0-9]{8}\.md$/.test(file))).toHaveLength(2);
  });

  test("listSkillVersions also reads legacy .versions backups", async () => {
    const { root, skillPath } = makeSkillFile();
    roots.push(root);
    const legacyVersionsDir = join(dirname(skillPath), ".versions");
    mkdirSync(legacyVersionsDir, { recursive: true });
    writeFileSync(
      join(legacyVersionsDir, "SKILL_20260605_010203_abcd.md"),
      "# Demo Skill\n\nLegacy backup.",
      "utf-8"
    );

    const versions = await listSkillVersions(skillPath);

    expect(versions.map((version) => version.filename)).toEqual(["SKILL_20260605_010203_abcd.md"]);
  });

  test("applySkillImprovement 中止写入当技能文件在模型调用窗口被外部修改", async () => {
    const { root, skillPath } = makeSkillFile("# Demo Skill\n\nOriginal.");
    roots.push(root);
    const externalContent = "# Demo Skill\n\nExternal edit during model call.";

    const result = await applySkillImprovement({
      skillPath,
      updates: [{ section: "Rules", change: "Use the new rule", reason: "Test" }],
      callModel: async () => {
        // Simulate an external writer landing inside the long model-call window.
        writeFileSync(skillPath, externalContent, "utf-8");
        return "<updated_file># Demo Skill\n\nNew rule.</updated_file>";
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("外部修改");
    expect(readFileSync(skillPath, "utf-8")).toBe(externalContent);
    expect(existsSync(join(dirname(skillPath), "versions"))).toBe(true);
    const versionFiles = await readdir(join(dirname(skillPath), "versions"));
    expect(versionFiles).toHaveLength(0);
  });

  test("applySkillImprovement 排队等待既有文件锁后正常写入", async () => {
    const { root, skillPath } = makeSkillFile("# Demo Skill\n\nOld rule.");
    roots.push(root);

    let releaseExternal!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseExternal = resolve;
    });
    const externalHolder = withFileMutationLock(skillPath, async () => {
      await gate;
    });

    const applyPromise = applySkillImprovement({
      skillPath,
      updates: [{ section: "Rules", change: "Use the new rule", reason: "Test" }],
      callModel: async () => "<updated_file># Demo Skill\n\nNew rule.</updated_file>",
    });

    releaseExternal();
    await Promise.all([externalHolder, applyPromise.then((result) => {
      expect(result.success).toBe(true);
      expect(readFileSync(skillPath, "utf-8")).toBe("# Demo Skill\n\nNew rule.");
    })]);
  });

  test("restoreSkillVersion 备份当前内容失败即中止，不再覆盖", async () => {
    const { root, skillDir } = makeSkillFile();
    roots.push(root);
    // Target skill file does not exist, so the pre-restore backup cannot succeed.
    const skillPath = join(skillDir, "SKILL.md");
    rmSync(skillPath);
    const versionsDir = join(skillDir, "versions");
    mkdirSync(versionsDir, { recursive: true });
    writeFileSync(
      join(versionsDir, "2026-08-22_010203_abcd1234.md"),
      "# Demo Skill\n\nBackup content.",
      "utf-8"
    );

    const restored = await restoreSkillVersion({
      skillPath,
      filename: "2026-08-22_010203_abcd1234.md",
    });

    expect(restored.success).toBe(false);
    expect(restored.error).toContain("备份当前内容失败");
    expect(existsSync(skillPath)).toBe(false);
  });
});
