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
      roots: [root]
    });

    expect(skills.map((item) => item.name)).toContain("planner");
    expect(skills.find((item) => item.name === "planner")?.invocationDescriptor).toMatchObject({
      argumentToken: "${ARG}",
      context: "inline",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("未传 roots 时应默认加载 cwd 下的项目级 .lume skills", async () => {
  const cwd = join(tmpdir(), `sdk-cwd-skills-${Date.now()}`);
  const skillDir = join(cwd, ".lume", "skills", "project-planner");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: Project Planner\ndescription: project skill\n---\nPlan ${ARG}.",
    "utf-8"
  );

  try {
    const skills = await loadFilesystemSkills({ cwd });

    expect(skills.map((item) => item.name)).toContain("project-planner");
    await expect(
      skills.find((item) => item.name === "project-planner")?.getPrompt("the work", { cwd } as any)
    ).resolves.toEqual([{ type: "text", text: "Plan the work." }]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("未传 roots 时应先加载全局 skills 再加载项目级 .lume skills", async () => {
  const root = join(tmpdir(), `sdk-default-roots-${Date.now()}`);
  const configDir = join(root, "config");
  const cwd = join(root, "workspace");
  const previousConfigDir = process.env.LUME_CONFIG_DIR;

  process.env.LUME_CONFIG_DIR = configDir;
  mkdirSync(join(configDir, "skills", "global-helper"), { recursive: true });
  mkdirSync(join(configDir, "skills", "reviewer"), { recursive: true });
  mkdirSync(join(cwd, ".lume", "skills", "reviewer"), { recursive: true });

  writeFileSync(
    join(configDir, "skills", "global-helper", "SKILL.md"),
    "---\nname: Global Helper\ndescription: global only\n---\nGlobal helper.",
    "utf-8"
  );
  writeFileSync(
    join(configDir, "skills", "reviewer", "SKILL.md"),
    "---\nname: Global Reviewer\ndescription: global reviewer\n---\nGlobal review.",
    "utf-8"
  );
  writeFileSync(
    join(cwd, ".lume", "skills", "reviewer", "SKILL.md"),
    "---\nname: Project Reviewer\ndescription: project reviewer\n---\nProject review.",
    "utf-8"
  );

  try {
    const skills = await loadFilesystemSkills({ cwd });

    expect(skills.map((item) => item.name)).toContain("global-helper");
    expect(skills.find((item) => item.name === "reviewer")?.description).toBe("project reviewer");
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previousConfigDir;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("未传 roots 时应加载 Alice 兼容项目级 .alice skills 并覆盖全局 skills", async () => {
  const root = join(tmpdir(), `sdk-alice-project-roots-${Date.now()}`);
  const configDir = join(root, "config");
  const cwd = join(root, "workspace");
  const previousConfigDir = process.env.LUME_CONFIG_DIR;

  process.env.LUME_CONFIG_DIR = configDir;
  mkdirSync(join(configDir, "skills", "reviewer"), { recursive: true });
  mkdirSync(join(cwd, ".alice", "skills", "reviewer"), { recursive: true });

  writeFileSync(
    join(configDir, "skills", "reviewer", "SKILL.md"),
    "---\nname: Global Reviewer\ndescription: global reviewer\n---\nGlobal review.",
    "utf-8"
  );
  writeFileSync(
    join(cwd, ".alice", "skills", "reviewer", "SKILL.md"),
    "---\nname: Project Reviewer\ndescription: alice project reviewer\n---\nProject review.",
    "utf-8"
  );

  try {
    const skills = await loadFilesystemSkills({ cwd });

    expect(skills.find((item) => item.name === "reviewer")?.description).toBe("alice project reviewer");
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previousConfigDir;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("未传 roots 时 Alice 项目级 .alice skills 应覆盖旧 Lume 项目级 .lume skills", async () => {
  const root = join(tmpdir(), `sdk-alice-over-legacy-project-${Date.now()}`);
  const cwd = join(root, "workspace");

  mkdirSync(join(cwd, ".lume", "skills", "reviewer"), { recursive: true });
  mkdirSync(join(cwd, ".alice", "skills", "reviewer"), { recursive: true });

  writeFileSync(
    join(cwd, ".lume", "skills", "reviewer", "SKILL.md"),
    "---\nname: Legacy Project Reviewer\ndescription: legacy project reviewer\n---\nLegacy project review.",
    "utf-8"
  );
  writeFileSync(
    join(cwd, ".alice", "skills", "reviewer", "SKILL.md"),
    "---\nname: Alice Project Reviewer\ndescription: alice project reviewer\n---\nAlice project review.",
    "utf-8"
  );

  try {
    const skills = await loadFilesystemSkills({ cwd });

    const reviewer = skills.find((item) => item.name === "reviewer");
    expect(reviewer?.description).toBe("alice project reviewer");
    expect(reviewer?.sourcePath).toBe(join(cwd, ".alice", "skills", "reviewer", "SKILL.md"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("未传 roots 时应加载 Alice 兼容用户全局 skills 并覆盖旧 Lume 全局 skills", async () => {
  const root = join(tmpdir(), `sdk-alice-user-roots-${Date.now()}`);
  const configDir = join(root, "config");
  const aliceConfigDir = join(root, "alice");
  const cwd = join(root, "workspace");
  const previousConfigDir = process.env.LUME_CONFIG_DIR;
  const previousAliceConfigDir = process.env.ALICE_CONFIG_DIR;

  process.env.LUME_CONFIG_DIR = configDir;
  process.env.ALICE_CONFIG_DIR = aliceConfigDir;
  mkdirSync(join(configDir, "skills", "reviewer"), { recursive: true });
  mkdirSync(join(aliceConfigDir, "skills", "reviewer"), { recursive: true });

  writeFileSync(
    join(configDir, "skills", "reviewer", "SKILL.md"),
    "---\nname: Legacy Global Reviewer\ndescription: lume legacy reviewer\n---\nLegacy review.",
    "utf-8"
  );
  writeFileSync(
    join(aliceConfigDir, "skills", "reviewer", "SKILL.md"),
    "---\nname: Alice Global Reviewer\ndescription: alice global reviewer\n---\nAlice review.",
    "utf-8"
  );

  try {
    const skills = await loadFilesystemSkills({ cwd });

    expect(skills.find((item) => item.name === "reviewer")?.description).toBe("alice global reviewer");
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previousConfigDir;
    }
    if (previousAliceConfigDir === undefined) {
      delete process.env.ALICE_CONFIG_DIR;
    } else {
      process.env.ALICE_CONFIG_DIR = previousAliceConfigDir;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("应按 slug 注册 Alice 风格 SKILL.md 字段并保留展示名别名", async () => {
  const root = join(tmpdir(), `sdk-alice-skills-${Date.now()}`);
  const skillDir = join(root, "code-review");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    [
      "---",
      'name: "代码审查"',
      'description: "审查代码质量"',
      'allowed_tools: ["Read", "Bash"]',
      'activate_tools: ["mcp__node_repl__js"]',
      'argument_hint: "请提供文件路径"',
      "disable_model_invocation: true",
      'version: "1.2.3"',
      "---",
      "Review ${ARG}.",
    ].join("\n"),
    "utf-8"
  );

  try {
    const skills = await loadFilesystemSkills({
      cwd: process.cwd(),
      roots: [root]
    });

    const skill = skills.find((item) => item.name === "code-review");
    expect(skill).toBeDefined();
    expect(skill?.aliases).toContain("代码审查");
    expect(skill?.description).toBe("审查代码质量");
    expect(skill?.argumentHint).toBe("请提供文件路径");
    expect(skill?.allowedTools).toEqual(["Read", "Bash"]);
    expect(skill?.activatedTools).toEqual(["mcp__node_repl__js"]);
    expect(skill?.disableModelInvocation).toBe(true);
    expect(skill?.version).toBe("1.2.3");
    expect(skill?.sourcePath).toBe(join(skillDir, "SKILL.md"));
    await expect(skill?.getPrompt("src/index.ts", { cwd: process.cwd() } as any)).resolves.toEqual([
      { type: "text", text: "Review src/index.ts." }
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("应按 Alice 规则用后加载目录覆盖同名 skill 并按展示名稳定排序", async () => {
  const root = join(tmpdir(), `sdk-alice-skill-order-${Date.now()}`);
  const globalRoot = join(root, "global");
  const workspaceRoot = join(root, "workspace");

  mkdirSync(join(globalRoot, "reviewer"), { recursive: true });
  mkdirSync(join(workspaceRoot, "reviewer"), { recursive: true });
  mkdirSync(join(workspaceRoot, "z-last"), { recursive: true });

  writeFileSync(
    join(globalRoot, "reviewer", "SKILL.md"),
    "---\nname: Global Reviewer\ndescription: global copy\n---\nGlobal ${ARG}.",
    "utf-8"
  );
  writeFileSync(
    join(workspaceRoot, "reviewer", "SKILL.md"),
    "---\nname: Beta Reviewer\ndescription: workspace copy\n---\nWorkspace ${ARG}.",
    "utf-8"
  );
  writeFileSync(
    join(workspaceRoot, "z-last", "SKILL.md"),
    "---\nname: Alpha Helper\ndescription: sorted first\n---\nAlpha.",
    "utf-8"
  );

  try {
    const skills = await loadFilesystemSkills({
      cwd: process.cwd(),
      roots: [globalRoot, workspaceRoot]
    });

    expect(skills.map((item) => item.name)).toEqual(["z-last", "reviewer"]);
    const reviewer = skills.find((item) => item.name === "reviewer");
    expect(reviewer?.description).toBe("workspace copy");
    expect(reviewer?.sourcePath).toBe(join(workspaceRoot, "reviewer", "SKILL.md"));
    await expect(reviewer?.getPrompt("src/index.ts", { cwd: process.cwd() } as any)).resolves.toEqual([
      { type: "text", text: "Workspace src/index.ts." }
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("root-aware 过滤跳过后加载目录时应保留前面目录的同名 skill", async () => {
  const root = join(tmpdir(), `sdk-filtered-skill-roots-${Date.now()}`);
  const globalRoot = join(root, "global");
  const workspaceRoot = join(root, "workspace");

  mkdirSync(join(globalRoot, "reviewer"), { recursive: true });
  mkdirSync(join(workspaceRoot, "reviewer"), { recursive: true });
  mkdirSync(join(workspaceRoot, "planner"), { recursive: true });

  writeFileSync(
    join(globalRoot, "reviewer", "SKILL.md"),
    "---\nname: Global Reviewer\ndescription: global copy\n---\nGlobal review.",
    "utf-8"
  );
  writeFileSync(
    join(workspaceRoot, "reviewer", "SKILL.md"),
    "---\nname: Workspace Reviewer\ndescription: workspace copy\n---\nWorkspace review.",
    "utf-8"
  );
  writeFileSync(
    join(workspaceRoot, "planner", "SKILL.md"),
    "---\nname: Planner\ndescription: workspace planner\n---\nPlan.",
    "utf-8"
  );

  try {
    const skills = await loadFilesystemSkills({
      cwd: process.cwd(),
      roots: [globalRoot, workspaceRoot],
      shouldLoadSkill: ({ root, skillName }) => root !== workspaceRoot || skillName !== "reviewer"
    });

    expect(skills.find((item) => item.name === "reviewer")?.description).toBe("global copy");
    expect(skills.find((item) => item.name === "planner")?.description).toBe("workspace planner");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("应解析 Alice SKILL.md 中的 YAML 多行工具白名单", async () => {
  const root = join(tmpdir(), `sdk-alice-skill-yaml-list-${Date.now()}`);
  const skillDir = join(root, "code-review");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "name: Code Review",
      "description: Review code",
      "allowed_tools:",
      "  - Read",
      "  - Bash",
      "---",
      "Review the code.",
    ].join("\n"),
    "utf-8"
  );

  try {
    const skills = await loadFilesystemSkills({
      cwd: process.cwd(),
      roots: [root]
    });

    expect(skills.find((item) => item.name === "code-review")?.allowedTools).toEqual(["Read", "Bash"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("应解析 Alice SKILL.md 中的 YAML 多行文本字段", async () => {
  const root = join(tmpdir(), `sdk-alice-skill-yaml-text-${Date.now()}`);
  const skillDir = join(root, "researcher");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "name: Researcher",
      "description: |",
      "  多源交叉验证。",
      "  自动归档证据。",
      "---",
      "Research with care.",
    ].join("\n"),
    "utf-8"
  );

  try {
    const skills = await loadFilesystemSkills({
      cwd: process.cwd(),
      roots: [root]
    });

    const skill = skills.find((item) => item.name === "researcher");
    expect(skill?.description).toBe("多源交叉验证。\n自动归档证据。");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("getPrompt 展开参数时保持 $&/$$ 等替换序列字面不变", async () => {
  const root = join(tmpdir(), `sdk-skills-replace-patterns-${Date.now()}`);
  const skillDir = join(root, "echo");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: echo\ndescription: demo\n---\nARG:${ARG}:END",
    "utf-8"
  );

  try {
    const skills = await loadFilesystemSkills({ cwd: process.cwd(), roots: [root] });
    const skill = skills.find((item) => item.name === "echo");
    const args = "$& $` $$ $' $<name>";
    await expect(skill?.getPrompt(args, { cwd: process.cwd() } as any)).resolves.toEqual([
      { type: "text", text: `ARG:${args}:END` },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
