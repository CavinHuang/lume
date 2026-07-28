import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { basename, join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  getAgentThreadRootPath,
  getConfigDir,
  getLumeConfigYamlPath
} from "../services/infra/config-paths";
import {
  appendAgentTranscriptMessage,
  updateAgentThreadMeta
} from "../services/agent/agent-thread-manager";

mock.module("../services/agent/agent-service", () => ({
  appendAgentMessage: (
    input: { threadId: string; userMessage: string },
    emit: {
      onMessageAppended?: (event: {
        threadId: string;
        message: {
          id: string;
          role: "assistant";
          content: string;
          createdAt: number;
        };
      }) => void;
      onComplete: () => void;
    }
  ) => {
    emit.onMessageAppended?.({
      threadId: input.threadId,
      message: {
        id: `assistant:${input.userMessage}`,
        role: "assistant",
        content: `reply:${input.userMessage}`,
        createdAt: Date.now()
      }
    });
    emit.onComplete();

    return {
      ok: true as const,
      mode: "sent" as const,
      queuedCount: 0
    };
  },
  sendAgentMessage: async () => undefined,
  generateAgentTitle: async () => undefined,
  generateWelcomeSuggestions: async () => [],
  getAgentSubmissionReceipt: () => undefined,
  listAgentMessageQueue: () => [],
  promoteQueuedAgentMessageToGuidance: () => undefined,
  prepareAgentDispatchInput: async (input: unknown) => input,
  removeQueuedAgentMessage: () => undefined,
  reorderAgentMessageQueue: () => undefined,
  updateQueuedAgentMessage: () => undefined,
  stopAgent: async () => undefined,
  submitAgentToolPermission: () => false,
  submitAskUserQuestionAnswers: () => false
}));

async function createRuntime() {
  const { createCliRuntime } = await import("./cli-runtime");
  return createCliRuntime();
}

describe("cli-runtime", () => {
  let previousConfigDir: string | undefined;
  let tempConfigDir = "";
  let tempSourceDir = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-cli-runtime-config-"));
    tempSourceDir = mkdtempSync(join(tmpdir(), "lume-cli-runtime-source-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previousConfigDir;
    }

    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }

    if (tempSourceDir) {
      rmSync(tempSourceDir, { recursive: true, force: true });
      tempSourceDir = "";
    }
  });

  function projectPath(name: string): string {
    const path = join(tempSourceDir, name);
    mkdirSync(path, { recursive: true });
    return path;
  }

  test("list/create workspace by slug", async () => {
    const runtime = await createRuntime();

    expect(await runtime.listWorkspaces()).toEqual([]);

    const created = await runtime.createWorkspace({
      projectPath: projectPath("cli-workspace"),
      name: "CLI Workspace",
      slug: "  My_Custom Slug  "
    });

    expect(created.slug).toBe("my-custom-slug");

    const workspaces = await runtime.listWorkspaces();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.slug).toBe("my-custom-slug");
    expect(workspaces[0]?.id).toBe(created.id);
  });

  test("status ensures config dir exists and health returns the exact shape", async () => {
    const runtime = await createRuntime();
    const expectedConfigDir = getConfigDir();

    rmSync(expectedConfigDir, { recursive: true, force: true });
    expect(existsSync(expectedConfigDir)).toBeFalse();

    await expect(runtime.status()).resolves.toEqual({
      ok: true,
      runtime: "ready"
    });
    expect(existsSync(expectedConfigDir)).toBeTrue();

    await expect(runtime.health()).resolves.toEqual({
      ok: true,
      configDir: expectedConfigDir,
      lumeConfigExists: false
    });

    writeFileSync(getLumeConfigYamlPath(), "version: 1\n", "utf-8");

    await expect(runtime.health()).resolves.toEqual({
      ok: true,
      configDir: expectedConfigDir,
      lumeConfigExists: true
    });
  });

  test("create thread in workspace, add file, list file", async () => {
    const runtime = await createRuntime();
    const workspace = await runtime.createWorkspace({
      projectPath: projectPath("files-workspace"),
      name: "Files Workspace",
      slug: "files-workspace"
    });
    const thread = await runtime.createThread({
      workspaceSlug: workspace.slug,
      title: "File thread"
    });

    const sourcePath = join(tempSourceDir, "brief.md");
    writeFileSync(sourcePath, "# Brief\n", "utf-8");

    const added = await runtime.addFileToThread({
      threadId: thread.id,
      sourcePath
    });

    expect(added.filename).toBe(basename(sourcePath));

    const files = await runtime.listFiles({ threadId: thread.id });
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("brief.md");
    expect(files[0]?.relativePath).toBe("brief.md");
    expect(files[0]?.kind).toBe("file");
  });

  test("listThreads rejects an unknown workspace slug", async () => {
    const runtime = await createRuntime();

    await expect(runtime.listThreads({ workspaceSlug: "missing-workspace" })).rejects.toThrow(
      "工作区不存在: missing-workspace"
    );
  });

  test("listThreads preserves workspaceSlug via thread directory fallback", async () => {
    const runtime = await createRuntime();
    const workspace = await runtime.createWorkspace({
      projectPath: projectPath("fallback-workspace"),
      name: "Fallback Workspace",
      slug: "fallback-workspace"
    });
    const thread = await runtime.createThread({
      workspaceSlug: workspace.slug,
      title: "Fallback thread"
    });

    getAgentThreadRootPath(workspace.slug, thread.id);
    updateAgentThreadMeta(thread.id, { workspaceId: undefined });

    const threads = await runtime.listThreads();

    expect(threads).toHaveLength(1);
    expect(threads[0]?.id).toBe(thread.id);
    expect(threads[0]?.workspaceSlug).toBe(workspace.slug);
  });

  test("add workspace file and list workspace files by workspaceSlug", async () => {
    const runtime = await createRuntime();
    const workspace = await runtime.createWorkspace({
      projectPath: projectPath("workspace-files"),
      name: "Workspace Files",
      slug: "workspace-files"
    });

    const sourcePath = join(tempSourceDir, "shared-brief.md");
    writeFileSync(sourcePath, "# Shared Brief\n", "utf-8");

    const added = await runtime.addFileToWorkspace({
      workspaceSlug: workspace.slug,
      sourcePath
    });

    expect(added.filename).toBe(basename(sourcePath));

    const files = await runtime.listFiles({ workspaceSlug: workspace.slug });
    const sharedFile = files.find((file) => file.name === "shared-brief.md");

    expect(sharedFile).toBeDefined();
    expect(sharedFile?.relativePath).toBe("shared-brief.md");
    expect(sharedFile?.kind).toBe("file");
  });

  test("getThreadMessages accepts an input object and supports limit", async () => {
    const runtime = await createRuntime();
    const workspace = await runtime.createWorkspace({
      projectPath: projectPath("messages-workspace"),
      name: "Messages Workspace",
      slug: "messages-workspace"
    });
    const thread = await runtime.createThread({
      workspaceSlug: workspace.slug,
      title: "Messages thread"
    });

    appendAgentTranscriptMessage(thread.id, {
      id: "msg-1",
      role: "user",
      content: "first",
      createdAt: 1
    });
    appendAgentTranscriptMessage(thread.id, {
      id: "msg-2",
      role: "assistant",
      content: "second",
      createdAt: 2
    });

    const allMessages = await runtime.getThreadMessages({ threadId: thread.id });
    const limitedMessages = await runtime.getThreadMessages({ threadId: thread.id, limit: 1 });

    expect(allMessages).toHaveLength(2);
    expect(limitedMessages).toHaveLength(1);
    expect(limitedMessages[0]?.content).toBe("second");
  });

  test("missing workspace and thread file operations throw explicit errors", async () => {
    const runtime = await createRuntime();
    const sourcePath = join(tempSourceDir, "missing.md");
    writeFileSync(sourcePath, "# Missing\n", "utf-8");

    await expect(runtime.createThread({ workspaceSlug: "missing-workspace" })).rejects.toThrow(
      "工作区不存在: missing-workspace"
    );
    await expect(runtime.listFiles({ threadId: "missing-thread" })).rejects.toThrow(
      "线程不存在: missing-thread"
    );
    await expect(runtime.addFileToThread({ threadId: "missing-thread", sourcePath })).rejects.toThrow(
      "线程不存在: missing-thread"
    );
    await expect(runtime.listThreads({ workspaceSlug: "missing-workspace" })).rejects.toThrow(
      "工作区不存在: missing-workspace"
    );
    await expect(runtime.listFiles({ workspaceSlug: "missing-workspace" })).rejects.toThrow(
      "工作区不存在: missing-workspace"
    );
    await expect(runtime.addFileToWorkspace({ workspaceSlug: "missing-workspace", sourcePath })).rejects.toThrow(
      "工作区不存在: missing-workspace"
    );
  });

  test("sendThreadMessage returns accepted metadata and collects final assistant text", async () => {
    const runtime = await createRuntime();
    const thread = await runtime.createThread({
      title: "Send thread"
    });

    await expect(runtime.sendThreadMessage({
      threadId: thread.id,
      text: "hello"
    })).resolves.toEqual({
      accepted: {
        ok: true,
        threadId: thread.id,
        mode: "sent",
        queuedCount: 0
      },
      text: "reply:hello"
    });
  });

  test("ask remains callable when the runtime method is detached from its object", async () => {
    const runtime = await createRuntime();
    const ask = runtime.ask;

    await expect(ask({ text: "detached hello" })).resolves.toBe("reply:detached hello");
  });
});
