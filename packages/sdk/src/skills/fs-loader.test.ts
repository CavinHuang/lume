import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFilesystemSkills } from "./fs-loader";

test("应优先加载传入的 skillsDirectories", async () => {
  const root = join(tmpdir(), `sdk-skills-${Date.now()}`);
  const skillDir = join(root, "planner");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: planner\ndescription: demo\n---\n# demo",
    "utf-8"
  );

  try {
    const skills = await loadFilesystemSkills({
      cwd: process.cwd(),
      roots: [root],
      includeLegacyFallback: false
    });

    expect(skills.map((item) => item.name)).toContain("planner");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
