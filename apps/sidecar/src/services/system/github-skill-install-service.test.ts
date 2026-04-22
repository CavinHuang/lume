import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWorkspaceSkillsDir } from "../infra/config-paths";
import { getInstalledSkillSourceMetadata } from "./skills-market-metadata";
import {
  __internal,
  getGitHubSkillReview,
  installGitHubSkillToWorkspace
} from "./github-skill-install-service";

function withTempConfigDir(): () => void {
  const previous = process.env.LUME_CONFIG_DIR;
  const next = join(tmpdir(), `lume-github-skill-install-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  process.env.LUME_CONFIG_DIR = next;
  return () => {
    if (previous === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previous;
    }
    rmSync(next, { recursive: true, force: true });
  };
}

function createJsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function createTextResponse(data: string): Response {
  return new Response(data, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}

function createMockFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url === "https://api.github.com/repos/acme/agent-skills") {
      return createJsonResponse({
        default_branch: "main",
        pushed_at: "2026-04-21T00:00:00Z",
        owner: { login: "acme" }
      });
    }

    if (url === "https://api.github.com/repos/acme/agent-skills/git/trees/main?recursive=1") {
      return createJsonResponse({
        tree: [
          { path: "prompt-library/SKILL.md", type: "blob" },
          { path: "prompt-library/README.md", type: "blob" },
          { path: "prompt-library/scripts/check.sh", type: "blob" }
        ]
      });
    }

    if (url === "https://raw.githubusercontent.com/acme/agent-skills/main/prompt-library/SKILL.md") {
      return createTextResponse("---\nname: Prompt Library\ndescription: Prompt helpers\nversion: 1.0.0\n---\n# Prompt Library\n");
    }

    if (url === "https://raw.githubusercontent.com/acme/agent-skills/main/prompt-library/README.md") {
      return createTextResponse("# Prompt Library\n");
    }

    if (url === "https://raw.githubusercontent.com/acme/agent-skills/main/prompt-library/scripts/check.sh") {
      return createTextResponse("#!/bin/sh\necho ok\n");
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function createMultiSkillMockFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url === "https://api.github.com/repos/acme/agent-pack") {
      return createJsonResponse({
        default_branch: "main",
        owner: { login: "acme" }
      });
    }

    if (url === "https://api.github.com/repos/acme/agent-pack/git/trees/main?recursive=1") {
      return createJsonResponse({
        tree: [
          { path: "alpha/SKILL.md", type: "blob" },
          { path: "alpha/README.md", type: "blob" },
          { path: "beta/SKILL.md", type: "blob" }
        ]
      });
    }

    if (url === "https://raw.githubusercontent.com/acme/agent-pack/main/alpha/SKILL.md") {
      return createTextResponse("---\nname: Alpha\n---\n# Alpha\n");
    }

    if (url === "https://raw.githubusercontent.com/acme/agent-pack/main/alpha/README.md") {
      return createTextResponse("# Alpha\n");
    }

    if (url === "https://raw.githubusercontent.com/acme/agent-pack/main/beta/SKILL.md") {
      return createTextResponse("---\nname: Beta\n---\n# Beta\n");
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function createSlashBranchMockFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url === "https://api.github.com/repos/acme/agent-skills") {
      return createJsonResponse({
        default_branch: "feature/foo",
        owner: { login: "acme" }
      });
    }

    if (url === "https://api.github.com/repos/acme/agent-skills/git/trees/feature%2Ffoo?recursive=1") {
      return createJsonResponse({
        tree: [
          { path: "prompt-library/SKILL.md", type: "blob" }
        ]
      });
    }

    if (url === "https://raw.githubusercontent.com/acme/agent-skills/feature/foo/prompt-library/SKILL.md") {
      return createTextResponse("---\nname: Prompt Library\n---\n# Prompt Library\n");
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("github-skill-install-service", () => {
  let restoreEnv: (() => void) | null = null;

  afterEach(() => {
    restoreEnv?.();
    restoreEnv = null;
  });

  test("parses public github repo and tree URLs", () => {
    expect(__internal.parseGitHubUrl("https://github.com/acme/agent-skills")).toMatchObject({
      owner: "acme",
      repo: "agent-skills",
      ref: undefined,
      rootPath: ""
    });

    expect(__internal.parseGitHubUrl("https://github.com/acme/agent-skills/tree/main/prompt-library")).toMatchObject({
      owner: "acme",
      repo: "agent-skills",
      ref: "main",
      rootPath: "prompt-library"
    });
  });

  test("resolves tree URLs when branch ref contains slashes", async () => {
    const result = await getGitHubSkillReview(
      { url: "https://github.com/acme/agent-skills/tree/feature/foo/prompt-library" },
      { fetchImpl: createSlashBranchMockFetch() }
    );

    expect(result.ref).toBe("feature/foo");
    expect(result.rootPath).toBe("prompt-library");
  });

  test("marks repos with scripts as review-required", async () => {
    const result = await getGitHubSkillReview(
      { url: "https://github.com/acme/agent-skills" },
      { fetchImpl: createMockFetch() }
    );

    expect(result.trustLevel).toBe("review-required");
    expect(result.reviewToken.length).toBeGreaterThan(0);
    expect(result.skills.map((item) => item.slug)).toEqual(["prompt-library"]);
    expect(result.riskSummary.some((item) => item.includes("scripts"))).toBe(true);
    expect(Array.isArray(result.structuralIssues)).toBe(true);
  });

  test("rejects non-github URLs in phase 1", async () => {
    await expect(getGitHubSkillReview(
      { url: "https://gitlab.com/acme/agent-skills" },
      { fetchImpl: createMockFetch() }
    )).rejects.toThrow("仅支持公开 github.com 仓库");
  });

  test("installs detected skill folders into the target workspace", async () => {
    restoreEnv = withTempConfigDir();
    const review = await getGitHubSkillReview(
      { url: "https://github.com/acme/agent-skills" },
      { fetchImpl: createMockFetch() }
    );

    const result = await installGitHubSkillToWorkspace(
      {
        url: "https://github.com/acme/agent-skills",
        workspaceSlug: "demo",
        reviewToken: review.reviewToken
      },
      { fetchImpl: createMockFetch() }
    );

    const skillDir = join(getWorkspaceSkillsDir("demo"), "prompt-library");
    expect(result.imported).toBe(true);
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
    expect(readFileSync(join(skillDir, "README.md"), "utf-8")).toContain("Prompt Library");
    expect(getInstalledSkillSourceMetadata("demo")["prompt-library"]?.sourceType).toBe("github");
  });

  test("returns imported false when target skill exists and overwrite is false", async () => {
    restoreEnv = withTempConfigDir();
    const review = await getGitHubSkillReview(
      { url: "https://github.com/acme/agent-skills" },
      { fetchImpl: createMockFetch() }
    );

    const skillDir = join(getWorkspaceSkillsDir("demo"), "prompt-library");
    rmSync(skillDir, { recursive: true, force: true });
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# existing\n", "utf-8");

    const result = await installGitHubSkillToWorkspace(
      {
        url: "https://github.com/acme/agent-skills",
        workspaceSlug: "demo",
        reviewToken: review.reviewToken
      },
      { fetchImpl: createMockFetch() }
    );

    expect(result.imported).toBe(false);
    expect(result.reason).toContain("已存在");
  });

  test("rejects install when review token is missing", async () => {
    restoreEnv = withTempConfigDir();

    await expect(installGitHubSkillToWorkspace(
      { url: "https://github.com/acme/agent-skills", workspaceSlug: "demo" } as never,
      { fetchImpl: createMockFetch() }
    )).rejects.toThrow("请先完成安装前审查");
  });

  test("does not partially install multi-skill repos when a later target conflicts", async () => {
    restoreEnv = withTempConfigDir();
    const review = await getGitHubSkillReview(
      { url: "https://github.com/acme/agent-pack" },
      { fetchImpl: createMultiSkillMockFetch() }
    );

    const existingSkillDir = join(getWorkspaceSkillsDir("demo"), "beta");
    mkdirSync(existingSkillDir, { recursive: true });
    writeFileSync(join(existingSkillDir, "SKILL.md"), "# existing beta\n", "utf-8");

    const result = await installGitHubSkillToWorkspace(
      {
        url: "https://github.com/acme/agent-pack",
        workspaceSlug: "demo",
        reviewToken: review.reviewToken
      },
      { fetchImpl: createMultiSkillMockFetch() }
    );

    expect(result.imported).toBe(false);
    expect(existsSync(join(getWorkspaceSkillsDir("demo"), "alpha", "SKILL.md"))).toBe(false);
  });
});
