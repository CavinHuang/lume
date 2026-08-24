import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findProjectInstructionsFile,
  loadProjectInstructions,
  truncateProjectInstructions
} from "./project-instructions";

describe("project-instructions", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lume-proj-instr-test-"));
  });

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  test("同层 CLAUDE.md 直接命中，祖先目录起探测可命中父层", () => {
    mkdirSync(join(root, "proj"), { recursive: true });
    writeFileSync(join(root, "proj", "CLAUDE.md"), "# proj rules", "utf-8");
    expect(findProjectInstructionsFile(join(root, "proj"))).toBe(join(root, "proj", "CLAUDE.md"));
    // 子目录向上爬到 proj 层命中
    const sub = join(root, "proj", "src", "deep");
    mkdirSync(sub, { recursive: true });
    expect(findProjectInstructionsFile(sub)).toBe(join(root, "proj", "CLAUDE.md"));
  });

  test("无 CLAUDE.md 时回退 AGENTS.md，同层 CLAUDE.md 优先", () => {
    writeFileSync(join(root, "AGENTS.md"), "# agents", "utf-8");
    expect(findProjectInstructionsFile(root)).toBe(join(root, "AGENTS.md"));
    writeFileSync(join(root, "CLAUDE.md"), "# claude", "utf-8");
    expect(findProjectInstructionsFile(root)).toBe(join(root, "CLAUDE.md"));
  });

  test("就近覆盖：父子两层都有时取最近一层", () => {
    const proj = join(root, "proj");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "# outer", "utf-8");
    writeFileSync(join(proj, "CLAUDE.md"), "# inner", "utf-8");
    expect(findProjectInstructionsFile(proj)).toBe(join(proj, "CLAUDE.md"));
  });

  test("git root 是向上边界：边界之外的同名文件不命中", () => {
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, ".git"), "gitdir: elsewhere", "utf-8");
    writeFileSync(join(root, "CLAUDE.md"), "# outside project boundary", "utf-8");
    expect(findProjectInstructionsFile(repo, { homeDir: root })).toBeNull();
    // git root 本层的候选仍然参与
    writeFileSync(join(repo, "AGENTS.md"), "# repo agents", "utf-8");
    expect(findProjectInstructionsFile(repo, { homeDir: root })).toBe(join(repo, "AGENTS.md"));
  });

  test("home 目录是向上边界：home 本层可达，其上不再爬", () => {
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "# home agents", "utf-8");
    expect(findProjectInstructionsFile(nested, { homeDir: root })).toBe(join(root, "AGENTS.md"));
  });

  test("loadProjectInstructions 剥 front matter 且截断超限内容并带标记", () => {
    writeFileSync(
      join(root, "CLAUDE.md"),
      ["---", "title: ignored", "---", "", "# body", "real content"].join("\n"),
      "utf-8"
    );
    const loaded = loadProjectInstructions(root, { homeDir: root });
    expect(loaded?.path).toBe(join(root, "CLAUDE.md"));
    expect(loaded?.truncated).toBeFalse();
    expect(loaded?.content).toContain("real content");
    expect(loaded?.content).not.toContain("ignored");

    const big = "x".repeat(40 * 1024);
    const truncated = truncateProjectInstructions(big);
    expect(truncated.truncated).toBeTrue();
    expect(truncated.content).toContain("(truncated by Lume project-instructions loader)");
    expect(truncated.content.length).toBeLessThan(big.length);
    // 头尾各半保留
    expect(truncated.content.startsWith("x")).toBeTrue();
    expect(truncated.content.endsWith("x")).toBeTrue();
  });

  test("loadProjectInstructions 以 cwd+mtimes 做缓存，mtime 未变时不重读", () => {
    const file = join(root, "CLAUDE.md");
    // 用同一固定时间戳写两次保证 stat 读数一致，规避 mtime round-trip 浮点误差
    const fixedTime = new Date(Date.now() - 10_000);
    writeFileSync(file, "# v1", "utf-8");
    utimesSync(file, fixedTime, fixedTime);
    const first = loadProjectInstructions(root, { homeDir: root });
    expect(first?.content).toBe("# v1");

    // 改内容但把 mtime 拨回同值 → 缓存仍返回旧内容，证明未重读
    writeFileSync(file, "# v2 should not be re-read", "utf-8");
    utimesSync(file, fixedTime, fixedTime);
    expect(loadProjectInstructions(root, { homeDir: root })?.content).toBe("# v1");

    // mtime 变化 → 重读新内容
    const newer = new Date(fixedTime.getTime() + 5000);
    utimesSync(file, newer, newer);
    expect(loadProjectInstructions(root, { homeDir: root })?.content).toBe("# v2 should not be re-read");
  });
});
