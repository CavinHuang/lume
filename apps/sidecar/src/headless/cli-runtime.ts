import { basename, join, relative, sep } from "node:path";
import { existsSync, statSync } from "node:fs";
import type {
  AgentMessage,
  AgentThreadMessageDispatchResult,
  AgentThreadMeta,
  AgentWorkspace,
  FileEntry
} from "@lume/shared";
import {
  createAgentWorkspace,
  getAgentWorkspace,
  getAgentWorkspaceBySlug,
  listAgentWorkspaces
} from "../services/agent/agent-workspace-manager";
import {
  createAgentThread,
  getAgentThreadMessages,
  getAgentThreadMeta,
  listAgentThreads
} from "../services/agent/agent-thread-manager";
import {
  listAgentDirectory,
  listWorkspaceDirectory,
  resolveWorkspaceSlugByThreadId,
  saveFilesToAgentThread,
  saveFilesToWorkspace
} from "../services/agent/agent-files-service";
import { resolveAgentThreadWorkdir } from "../services/agent/agent-workdir-resolver";
import {
  getAgentWorkspacePath,
  getConfigDir,
  getLumeConfigYamlPath,
  getWorkspaceResourcesPath
} from "../services/infra/config-paths";

export interface CliRuntimeWorkspace extends AgentWorkspace {
  path: string;
}

export interface CliRuntimeThread extends AgentThreadMeta {
  workspaceSlug?: string;
}

export interface CliRuntimeFileEntry {
  name: string;
  path: string;
  relativePath: string;
  kind: "file" | "dir";
  size: number;
  externalAttachment: FileEntry["externalAttachment"];
}

export interface CliRuntimeStatus {
  ok: true;
  runtime: "ready";
}

export interface CliRuntimeHealth {
  ok: true;
  configDir: string;
  lumeConfigExists: boolean;
}

export interface CreateCliWorkspaceInput {
  projectPath: string;
  name?: string;
  slug?: string;
}

export interface CreateCliThreadInput {
  title?: string;
  workspaceSlug?: string;
}

export interface ListCliThreadsInput {
  workspaceSlug?: string;
  limit?: number;
}

export interface ListCliFilesInput {
  workspaceSlug?: string;
  threadId?: string;
}

export interface AddCliThreadFileInput {
  threadId: string;
  sourcePath: string;
}

export interface AddCliWorkspaceFileInput {
  workspaceSlug: string;
  sourcePath: string;
}

export interface SendCliThreadMessageInput {
  threadId: string;
  text: string;
}

export interface CliRuntimeSendAccepted extends AgentThreadMessageDispatchResult {
  threadId: string;
}

export interface CliRuntimeSendThreadMessageResult {
  accepted: CliRuntimeSendAccepted;
  text: string;
}

export interface CliRuntimeAskInput {
  text: string;
  workspaceSlug?: string;
  threadId?: string;
}

export interface CliRuntime {
  status(): Promise<CliRuntimeStatus>;
  health(): Promise<CliRuntimeHealth>;
  listWorkspaces(): Promise<CliRuntimeWorkspace[]>;
  createWorkspace(input: CreateCliWorkspaceInput): Promise<CliRuntimeWorkspace>;
  listThreads(input?: ListCliThreadsInput): Promise<CliRuntimeThread[]>;
  createThread(input?: CreateCliThreadInput): Promise<CliRuntimeThread>;
  sendThreadMessage(input: SendCliThreadMessageInput): Promise<CliRuntimeSendThreadMessageResult>;
  ask(input: CliRuntimeAskInput): Promise<string>;
  getThreadMessages(input: { threadId: string; limit?: number }): Promise<AgentMessage[]>;
  listFiles(input: ListCliFilesInput): Promise<CliRuntimeFileEntry[]>;
  addFileToThread(input: AddCliThreadFileInput): Promise<{ filename: string; targetPath: string }>;
  addFileToWorkspace(input: AddCliWorkspaceFileInput): Promise<{ filename: string; targetPath: string }>;
}

function toCliWorkspace(workspace: AgentWorkspace): CliRuntimeWorkspace {
  return {
    ...workspace,
    path: getAgentWorkspacePath(workspace.slug)
  };
}

function requireWorkspaceBySlug(workspaceSlug: string): AgentWorkspace {
  const workspace = getAgentWorkspaceBySlug(workspaceSlug);
  if (!workspace) {
    throw new Error(`工作区不存在: ${workspaceSlug}`);
  }
  return workspace;
}

function requireThread(threadId: string): AgentThreadMeta {
  const thread = getAgentThreadMeta(threadId);
  if (!thread) {
    throw new Error(`线程不存在: ${threadId}`);
  }
  return thread;
}

function requireWorkspaceForThread(threadId: string): AgentWorkspace {
  const thread = requireThread(threadId);

  const workspace = resolveWorkspaceForThreadMeta(thread);
  if (workspace) {
    return workspace;
  }

  throw new Error(`线程未绑定工作区: ${threadId}`);
}

function resolveWorkspaceForThreadMeta(thread: AgentThreadMeta): AgentWorkspace | undefined {
  if (thread.workspaceId) {
    const workspace = getAgentWorkspace(thread.workspaceId);
    if (workspace) {
      return workspace;
    }
  }

  const workspaceSlug = resolveWorkspaceSlugByThreadId(thread.id);
  if (workspaceSlug) {
    return requireWorkspaceBySlug(workspaceSlug);
  }
}

function toCliThread(thread: AgentThreadMeta): CliRuntimeThread {
  return {
    ...thread,
    workspaceSlug: resolveWorkspaceForThreadMeta(thread)?.slug
  };
}

function toCliFileEntry(entry: FileEntry, rootPath: string): CliRuntimeFileEntry {
  const stats = statSync(entry.path);
  return {
    name: entry.name,
    path: entry.path,
    relativePath: relative(rootPath, entry.path).split(sep).join("/"),
    kind: entry.isDirectory ? "dir" : "file",
    size: entry.isDirectory ? 0 : stats.size,
    externalAttachment: entry.externalAttachment
  };
}

function resolveFilesRoot(input: ListCliFilesInput): { entries: FileEntry[]; rootPath: string } {
  if (input.threadId) {
    const rootPath = resolveAgentThreadWorkdir(input.threadId).lumeWorkDir;
    const entries = listAgentDirectory(undefined, input.threadId, rootPath);
    return { entries, rootPath };
  }

  if (input.workspaceSlug) {
    const workspace = requireWorkspaceBySlug(input.workspaceSlug);
    const entries = listWorkspaceDirectory(workspace.slug);
    const rootPath = getWorkspaceResourcesPath(workspace.slug);
    return { entries, rootPath };
  }

  throw new Error("listFiles 需要 threadId 或 workspaceSlug");
}

async function dispatchThreadMessage(input: SendCliThreadMessageInput): Promise<CliRuntimeSendThreadMessageResult> {
  requireThread(input.threadId);
  const { appendAgentMessage } = await import("../services/agent/agent-service");

  let finalAssistantText = "";
  const acceptedResult: CliRuntimeSendAccepted = {
    ok: true,
    threadId: input.threadId,
    mode: "sent",
    queuedCount: 0
  };

  const completion = new Promise<string>((resolve, reject) => {
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };

    const accepted = appendAgentMessage({
      threadId: input.threadId,
      userMessage: input.text
    }, {
      onMessageAppended: (event) => {
        if (event.threadId === input.threadId && event.message.role === "assistant") {
          finalAssistantText = event.message.content;
        }
      },
      onComplete: () => {
        settle(() => resolve(finalAssistantText));
      },
      onError: (error) => {
        settle(() => reject(new Error(error)));
      },
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => {
        settle(() => reject(new Error("CLI 模式暂不支持 AskUserQuestion 交互")));
      },
      onBrowserAuthRequest: () => {
        settle(() => reject(new Error("CLI 模式暂不支持浏览器安全凭证交互")));
      },
      onToolPermissionRequest: () => {
        settle(() => reject(new Error("CLI 模式暂不支持工具权限交互")));
      }
    });

    Object.assign(acceptedResult, {
      ...accepted,
      threadId: input.threadId
    });
  });

  return {
    accepted: acceptedResult,
    text: await completion
  };
}

export function createCliRuntime(): CliRuntime {
  const runtime: CliRuntime = {
    async status() {
      getConfigDir();
      return {
        ok: true,
        runtime: "ready"
      };
    },

    async health() {
      const configDir = getConfigDir();
      return {
        ok: true,
        configDir,
        lumeConfigExists: existsSync(getLumeConfigYamlPath())
      };
    },

    async listWorkspaces() {
      return listAgentWorkspaces().map(toCliWorkspace);
    },

    async createWorkspace(input) {
      return toCliWorkspace(createAgentWorkspace(input.name ?? input.projectPath, {
        slug: input.slug,
        projectPath: input.projectPath
      }));
    },

    async listThreads(input = {}) {
      const workspaceSlug = input.workspaceSlug?.trim()
        ? requireWorkspaceBySlug(input.workspaceSlug).slug
        : undefined;

      const threads = listAgentThreads()
        .filter((thread) => !workspaceSlug || resolveWorkspaceForThreadMeta(thread)?.slug === workspaceSlug)
        .slice(0, input.limit ?? 20);

      return threads.map(toCliThread);
    },

    async createThread(input = {}) {
      const workspaceId = input.workspaceSlug
        ? requireWorkspaceBySlug(input.workspaceSlug).id
        : undefined;

      return toCliThread(
        createAgentThread(
          input.title,
          undefined,
          workspaceId,
          undefined,
          undefined,
          { fileContextMode: "newRoot" }
        )
      );
    },

    async sendThreadMessage(input) {
      return dispatchThreadMessage(input);
    },

    async ask(input) {
      const threadId = input.threadId
        ? requireThread(input.threadId).id
        : (await runtime.createThread({
            workspaceSlug: input.workspaceSlug
          })).id;

      return (await runtime.sendThreadMessage({
        threadId,
        text: input.text
      })).text;
    },

    async getThreadMessages(input) {
      requireThread(input.threadId);

      const messages = getAgentThreadMessages(input.threadId);
      if (input.limit === undefined) {
        return messages;
      }

      const safeLimit = Math.max(0, Math.floor(input.limit));
      return safeLimit === 0 ? [] : messages.slice(-safeLimit);
    },

    async listFiles(input) {
      const { entries, rootPath } = resolveFilesRoot(input);
      return entries.map((entry) => toCliFileEntry(entry, rootPath));
    },

    async addFileToThread(input) {
      const workspace = requireWorkspaceForThread(input.threadId);
      const [saved] = saveFilesToAgentThread({
        workspaceSlug: workspace.slug,
        threadId: input.threadId,
        files: [{
          filename: join("files", basename(input.sourcePath)),
          sourcePath: input.sourcePath
        }]
      });

      if (!saved) {
        throw new Error("线程文件附加失败");
      }

      return {
        filename: basename(saved.targetPath),
        targetPath: saved.targetPath
      };
    },

    async addFileToWorkspace(input) {
      const workspace = requireWorkspaceBySlug(input.workspaceSlug);
      const [saved] = saveFilesToWorkspace({
        workspaceSlug: workspace.slug,
        files: [{
          filename: basename(input.sourcePath),
          sourcePath: input.sourcePath
        }]
      });

      if (!saved) {
        throw new Error("工作区文件附加失败");
      }

      return {
        filename: basename(saved.targetPath),
        targetPath: saved.targetPath
      };
    }
  };

  return runtime;
}
