import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_AGENT_ROLES } from "@lume/shared";
import { parseSkillFrontmatter } from "./skill-frontmatter";

describe("default skills inventory", () => {
  test("every bundled default skill declares Alice core fields", () => {
    for (const slug of listDefaultSkillSlugs()) {
      const { meta } = readDefaultSkill(slug);

      expect(meta.name, `${slug} name`).toBeTruthy();
      expect(meta.description, `${slug} description`).toBeTruthy();
    }
  });

  test("bundles Alice-compatible general skills with required metadata and scoped tools", () => {
    for (const slug of ALICE_COMPATIBLE_GENERAL_SKILLS) {
      const { meta } = readDefaultSkill(slug);

      expect(meta.name).toBeTruthy();
      expect(meta.description).toBeTruthy();
      expect(meta.version).toBeTruthy();
      expect(meta.allowedTools?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("auto-invocable general skills only declare runtime-backed tools", () => {
    for (const slug of ALICE_COMPATIBLE_GENERAL_SKILLS) {
      const { meta } = readDefaultSkill(slug);
      if (meta.disableModelInvocation === true) continue;

      for (const tool of meta.allowedTools ?? []) {
        expect(isRuntimeBackedSkillTool(tool), `${slug} declares unsupported tool ${tool}`).toBe(true);
      }
    }
  });

  test("image-gen skill is backed by real image tools", () => {
    const { content, meta } = readDefaultSkill("image-gen");

    expect(meta.slug).toBe("image-gen");
    expect(meta.name).toBe("图片生成");
    expect(meta.description).toContain("生成");
    expect(meta.disableModelInvocation).toBeFalsy();
    expect(meta.allowedTools ?? []).toContain("image_gen");
    expect(meta.allowedTools ?? []).toContain("list_image_models");
    expect(content).not.toContain("尚未接入");
    expect(content).not.toContain("不要声称已经生成图片");
  });

  test("lume-mermaid skill documents the renderer-compatible dialect", () => {
    const { content, meta } = readDefaultSkill("lume-mermaid");

    expect(meta.name).toBe("Lume Mermaid 图解");
    expect(meta.description).toContain("beautiful-mermaid");
    expect(content).toContain('不要写成 `A["带引号文本"]`');
    expect(content).toContain("不要使用 `<br/>`");
    expect(content).toContain("只在关闭 `subgraph` 时使用 `end`");
    expect(content).toContain("不要输出当前渲染器不支持的 `accTitle`");
  });

  test("bundles one compact Lume Infographic skill with the safe renderer dialect", () => {
    const { content, meta } = readDefaultSkill("lume-infographic");

    expect(meta.name).toBe("lume-infographic");
    expect(meta.description).toContain("不按内容长度触发");
    expect(content).toContain("每次回复最多输出一张");
    expect(content).toContain("relation-dagre-flow-tb-badge-card");
    expect(content).toContain("禁止 HTML、外链脚本、URL");
    expect(content).toContain("不是 YAML");
    expect(content).toContain("`-` 必须缩进");
    expect(content).not.toContain("unpkg.com");
    expect(content).not.toContain("write_file");
  });

  test("bundles an auto-invocable ui-stylist skill backed by personalize_ui", () => {
    const { content, meta } = readDefaultSkill("ui-stylist");

    expect(meta.slug).toBe("ui-stylist");
    expect(meta.name).toBe("界面调整师");
    expect(meta.description).toContain("界面");
    expect(meta.disableModelInvocation).not.toBe(true);
    expect(meta.allowedTools).toEqual(["personalize_ui"]);
    expect(content).toContain("personalize_ui");
    expect(content).toContain("支持 themeMode、themePalette、customThemePalettes、activeView、promptSidebarOpen、sidePanelOpen");
    expect(content).toContain("upsert_theme");
    expect(content).toContain("delete_theme");
  });

  test("docsmith can use the real Office package tools while guarding unavailable Office tools", () => {
    const { content, meta } = readDefaultSkill("agent-docsmith");

    expect(meta.allowedTools).toContain("office_validate");
    expect(meta.allowedTools).toContain("office_unpack");
    expect(meta.allowedTools).toContain("office_pack");
    expect(content).toContain("当前 Lume 已接入 `office_validate`、`office_unpack` 和 `office_pack`");
    expect(content).not.toContain("尚未接入 `office_pack`");
    expect(content).not.toContain("尚未接入 `office_unpack`");
  });

  test("designer role does not describe the real Office validator as unavailable", () => {
    const { content } = readDefaultSkill("agent-designer");

    expect(content).toContain("office_validate");
    expect(content).not.toContain("office_unpack`、`office_pack`、`office_validate");
  });

  test("skill-creator teaches Alice-compatible storage paths", () => {
    const { content } = readDefaultSkill("skill-creator");

    expect(content).toContain("~/.alice/skills/<skill-name>/SKILL.md");
    expect(content).toContain("{workdir}/.alice/skills/<skill-name>/SKILL.md");
    expect(content).not.toContain("~/.lume/skills/<skill-name>/SKILL.md");
    expect(content).not.toContain("{workdir}/.lume/skills/<skill-name>/SKILL.md");
  });

  test("skill-creator lists specialized runtime-backed tools for allowed_tools", () => {
    const { content } = readDefaultSkill("skill-creator");

    expect(content).toContain("`office_validate`");
    expect(content).toContain("`office_unpack`");
    expect(content).toContain("`office_pack`");
    expect(content).toContain("`personalize_ui`");
    expect(content).toContain("`lume_reading_snapshot`");
    expect(content).toContain("`lume_generate_share_card`");
  });

  test("bundles every built-in agent role default skill", () => {
    for (const role of BUILTIN_AGENT_ROLES) {
      const { meta } = readDefaultSkill(role.defaultSkillName);

      expect(meta.slug).toBe(role.defaultSkillName);
      expect(meta.version, `${role.defaultSkillName} version`).toBeTruthy();
      expect(meta.allowedTools?.length ?? 0, `${role.defaultSkillName} allowed_tools`).toBeGreaterThan(0);
    }
  });

  test("built-in agent role skills only declare runtime-backed tools", () => {
    for (const role of BUILTIN_AGENT_ROLES) {
      const { meta } = readDefaultSkill(role.defaultSkillName);

      for (const tool of meta.allowedTools ?? []) {
        expect(
          isRuntimeBackedSkillTool(tool),
          `${role.defaultSkillName} declares unsupported tool ${tool}`
        ).toBe(true);
      }
    }
  });
});

const ALICE_COMPATIBLE_GENERAL_SKILLS = [
  "agent-wiki",
  "code-review",
  "explain-code",
  "image-gen",
  "skill-creator",
  "system-info",
  "ui-stylist"
];

const RUNTIME_BACKED_SKILL_TOOLS = new Set([
  "bash",
  "edit_file",
  "glob",
  "grep",
  "image_gen",
  "list_dir",
  "list_directory",
  "list_image_models",
  "lume_generate_share_card",
  "lume_reading_snapshot",
  "office_pack",
  "office_unpack",
  "office_validate",
  "personalize_ui",
  "read_file",
  "web_fetch",
  "web_search",
  "wiki.follow_links",
  "wiki.propose_changes",
  "wiki.read",
  "wiki.search",
  "write_file"
]);

function isRuntimeBackedSkillTool(tool: string): boolean {
  return RUNTIME_BACKED_SKILL_TOOLS.has(tool);
}

function readDefaultSkill(slug: string): { content: string; meta: ReturnType<typeof parseSkillFrontmatter> } {
  const filePath = join(import.meta.dir, "../../../default-skills", slug, "SKILL.md");
  expect(existsSync(filePath)).toBe(true);

  const content = readFileSync(filePath, "utf-8");
  return { content, meta: parseSkillFrontmatter(content, slug) };
}

function listDefaultSkillSlugs(): string[] {
  const defaultSkillsDir = join(import.meta.dir, "../../../default-skills");
  return readdirSync(defaultSkillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(defaultSkillsDir, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}
