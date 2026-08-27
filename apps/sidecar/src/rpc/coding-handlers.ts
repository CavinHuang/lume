import { AGENT_IPC_CHANNELS } from "@lume/shared";
import { isAgentRuntimeSessionActive } from "../services/agent-runtime/runner/attempt";
import { getRuntimeCoreSessionDir } from "../services/agent-runtime/runtime-core/session-store";
import { resolveAgentThreadWorkdir } from "../services/agent/agent-workdir-resolver";
import {
  applyCodingDiffAction,
  getCodingBlame,
  getCodingChangeSet,
  getCodingDiffMedia,
  getCodingFileOpenTargets,
  searchCodingDiffLines,
  searchCodingReview,
  type SearchableCodingDiff,
  getCodingReviewSources,
  getCodingRepositoryPublishState,
  applyCodingRepositoryPublishAction,
  getCodingFileDiff,
} from "../services/agent-runtime/runtime-core/coding-change-service";
import {
  getCodingDiffMediaFromCheckpoint,
  getCodingFileDiffFromCheckpoint,
  getCodingRunRoots,
  revertCodingFileFromCheckpoint,
  revertCodingRun,
} from "../services/agent-runtime/runtime-core/coding-run-checkpoint-service";
import {
  codingChangeSetInputSchema,
  codingDiffActionInputSchema,
  codingDiffMediaInputSchema,
  codingFileInputSchema,
  codingRunFileRevertInputSchema,
  codingRunRevertInputSchema,
  codingRepositoryInputSchema,
  codingRepositoryPublishActionInputSchema,
  codingReviewSearchInputSchema,
} from "./schemas";
import type { RpcHandler } from "./types";
import { validateInput } from "./validation";
import { createLogger, writeLogRecord } from "../services/infra/logger";

const log = createLogger("coding-handlers");

export function createCodingHandlers(): Record<string, RpcHandler> {
  return {
    [AGENT_IPC_CHANNELS.GET_CODING_REVIEW_SOURCES]: async (params) => {
      const input = validateInput(
        codingRepositoryInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_CODING_REVIEW_SOURCES,
      );
      const workdir = resolveAgentThreadWorkdir(input.threadId);
      const roots = await getCodingRunRoots({
        sessionDir: getRuntimeCoreSessionDir(input.threadId),
        runId: input.runId,
      });
      return getCodingReviewSources(workdir.agentCwd, {
        rootId: input.rootId,
        roots: roots.filter((root) => root !== workdir.agentCwd),
      });
    },
    [AGENT_IPC_CHANNELS.SEARCH_CODING_REVIEW]: async (params) => {
      const input = validateInput(
        codingReviewSearchInputSchema,
        params,
        AGENT_IPC_CHANNELS.SEARCH_CODING_REVIEW,
      );
      if (input.runId && !input.reviewSource) {
        const queue = input.files.map((file, index) => ({ file, index }));
        const files: Array<SearchableCodingDiff | undefined> = new Array(
          input.files.length,
        );
        const worker = async () => {
          while (queue.length > 0) {
            const item = queue.shift();
            if (!item) return;
            const { file, index } = item;
            const diff = await getCodingFileDiffFromCheckpoint({
              sessionDir: getRuntimeCoreSessionDir(input.threadId),
              runId: input.runId!,
              path: file.path,
              rootId: file.rootId,
            }).catch(() => null);
            files[index] = {
              ...file,
              lines: diff?.kind === "text" ? diff.lines : [],
            };
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(6, queue.length) }, worker),
        );
        return searchCodingDiffLines(
          files.filter(
            (file): file is SearchableCodingDiff => file !== undefined,
          ),
          input.query,
          input.limit,
        );
      }
      const workdir = resolveAgentThreadWorkdir(input.threadId);
      const roots = await getCodingRunRoots({
        sessionDir: getRuntimeCoreSessionDir(input.threadId),
        runId: input.runId,
      });
      return searchCodingReview(workdir.agentCwd, {
        query: input.query,
        limit: input.limit,
        files: input.files,
        reviewSource: input.reviewSource,
        roots: roots.filter((root) => root !== workdir.agentCwd),
      });
    },
    [AGENT_IPC_CHANNELS.GET_CODING_CHANGE_SET]: async (params) => {
      const input = validateInput(
        codingChangeSetInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_CODING_CHANGE_SET,
      );
      const workdir = resolveAgentThreadWorkdir(input.threadId);
      const roots = await getCodingRunRoots({
        sessionDir: getRuntimeCoreSessionDir(input.threadId),
        runId: input.runId,
      });
      const changeSet = await getCodingChangeSet(workdir.agentCwd, {
        paths: input.paths,
        reviewSource: input.reviewSource,
        roots: roots.filter((root) => root !== workdir.agentCwd),
      });
      return changeSet;
    },
    [AGENT_IPC_CHANNELS.GET_CODING_DIFF]: async (params) => {
      const input = validateInput(
        codingFileInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_CODING_DIFF,
      );
      const workdir = resolveAgentThreadWorkdir(input.threadId);
      const roots = await getCodingRunRoots({
        sessionDir: getRuntimeCoreSessionDir(input.threadId),
        runId: input.runId,
      });
      const diffOptions = {
        rootId: input.rootId,
        reviewSource: input.reviewSource,
        roots: roots.filter((root) => root !== workdir.agentCwd),
      };
      if (input.runId) {
        const checkpointDiff = await getCodingFileDiffFromCheckpoint({
          sessionDir: getRuntimeCoreSessionDir(input.threadId),
          runId: input.runId,
          path: input.path,
          rootId: input.rootId,
        });
        if (checkpointDiff) {
          const currentDiff = await getCodingFileDiff(
            workdir.agentCwd,
            input.path,
            diffOptions,
          ).catch(() => null);
          if (
            currentDiff?.kind === "text" &&
            checkpointDiff.kind === "text" &&
            currentDiff.oldContent === checkpointDiff.oldContent &&
            currentDiff.newContent === checkpointDiff.newContent
          ) {
            return currentDiff;
          }
          return checkpointDiff;
        }
      }
      return getCodingFileDiff(workdir.agentCwd, input.path, diffOptions);
    },
    [AGENT_IPC_CHANNELS.APPLY_CODING_DIFF_ACTION]: async (params) => {
      const input = validateInput(
        codingDiffActionInputSchema,
        params,
        AGENT_IPC_CHANNELS.APPLY_CODING_DIFF_ACTION,
      );
      if (isAgentRuntimeSessionActive(input.threadId)) {
        throw new Error("Coding Run 尚未结束，无法修改文件或 Git index");
      }
      const workdir = resolveAgentThreadWorkdir(input.threadId);
      const roots = await getCodingRunRoots({
        sessionDir: getRuntimeCoreSessionDir(input.threadId),
        runId: input.runId,
      });
      const actionPaths =
        input.scope === "section"
          ? input.files.map((file) => file.path)
          : [input.path];
      const changeSet = await getCodingChangeSet(workdir.agentCwd, {
        paths: actionPaths,
        reviewSource: { kind: input.stageFilter ?? "uncommitted" },
        roots: roots.filter((root) => root !== workdir.agentCwd),
      });
      const repository = input.rootId
        ? changeSet.repositories?.find(
            (candidate) => candidate.rootId === input.rootId,
          )
        : changeSet.repositories?.[0];
      if (repository?.kind !== "git") {
        throw new Error("非 Git 项目不支持 Git Diff 操作");
      }
      return applyCodingDiffAction(workdir.agentCwd, input, {
        roots: roots.filter((root) => root !== workdir.agentCwd),
      });
    },
    [AGENT_IPC_CHANNELS.GET_CODING_DIFF_MEDIA]: async (params) => {
      const input = validateInput(
        codingDiffMediaInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_CODING_DIFF_MEDIA,
      );
      if (input.runId) {
        const checkpointMedia = await getCodingDiffMediaFromCheckpoint({
          sessionDir: getRuntimeCoreSessionDir(input.threadId),
          runId: input.runId,
          path: input.path,
          rootId: input.rootId,
          side: input.side,
        });
        if (checkpointMedia) return checkpointMedia;
      }
      const workdir = resolveAgentThreadWorkdir(input.threadId);
      const roots = await getCodingRunRoots({
        sessionDir: getRuntimeCoreSessionDir(input.threadId),
        runId: input.runId,
      });
      return getCodingDiffMedia(workdir.agentCwd, input.path, input.side, {
        rootId: input.rootId,
        reviewSource: input.reviewSource,
        roots: roots.filter((root) => root !== workdir.agentCwd),
      });
    },
    [AGENT_IPC_CHANNELS.GET_CODING_BLAME]: async (params) => {
      const input = validateInput(
        codingFileInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_CODING_BLAME,
      );
      const workdir = resolveAgentThreadWorkdir(input.threadId);
      const roots = await getCodingRunRoots({
        sessionDir: getRuntimeCoreSessionDir(input.threadId),
        runId: input.runId,
      });
      return getCodingBlame(workdir.agentCwd, input.path, {
        rootId: input.rootId,
        roots: roots.filter((root) => root !== workdir.agentCwd),
      });
    },
    [AGENT_IPC_CHANNELS.GET_CODING_FILE_OPEN_TARGETS]: async (params) => {
      const input = validateInput(
        codingFileInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_CODING_FILE_OPEN_TARGETS,
      );
      const workdir = resolveAgentThreadWorkdir(input.threadId);
      const roots = await getCodingRunRoots({
        sessionDir: getRuntimeCoreSessionDir(input.threadId),
        runId: input.runId,
      });
      return getCodingFileOpenTargets(workdir.agentCwd, input.path, {
        rootId: input.rootId,
        roots: roots.filter((root) => root !== workdir.agentCwd),
      });
    },
    [AGENT_IPC_CHANNELS.GET_CODING_REPOSITORY_PUBLISH_STATE]: async (
      params,
    ) => {
      const input = validateInput(
        codingRepositoryInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_CODING_REPOSITORY_PUBLISH_STATE,
      );
      const workdir = resolveAgentThreadWorkdir(input.threadId);
      const roots = await getCodingRunRoots({
        sessionDir: getRuntimeCoreSessionDir(input.threadId),
        runId: input.runId,
      });
      return getCodingRepositoryPublishState(workdir.agentCwd, {
        rootId: input.rootId,
        roots: roots.filter((root) => root !== workdir.agentCwd),
      });
    },
    [AGENT_IPC_CHANNELS.APPLY_CODING_REPOSITORY_PUBLISH_ACTION]: async (
      params,
    ) => {
      const input = validateInput(
        codingRepositoryPublishActionInputSchema,
        params,
        AGENT_IPC_CHANNELS.APPLY_CODING_REPOSITORY_PUBLISH_ACTION,
      );
      if (isAgentRuntimeSessionActive(input.threadId)) {
        throw new Error("Coding Run 尚未结束，无法提交或推送");
      }
      const workdir = resolveAgentThreadWorkdir(input.threadId);
      const roots = await getCodingRunRoots({
        sessionDir: getRuntimeCoreSessionDir(input.threadId),
        runId: input.runId,
      });
      return applyCodingRepositoryPublishAction(workdir.agentCwd, input, {
        roots: roots.filter((root) => root !== workdir.agentCwd),
      });
    },
    [AGENT_IPC_CHANNELS.REVERT_CODING_RUN]: async (params) => {
      const input = validateInput(
        codingRunRevertInputSchema,
        params,
        AGENT_IPC_CHANNELS.REVERT_CODING_RUN,
      );
      if (isAgentRuntimeSessionActive(input.threadId)) {
        throw new Error("Coding Run 尚未结束，无法撤销文件改动");
      }
      const result = await revertCodingRun({
        sessionDir: getRuntimeCoreSessionDir(input.threadId),
        runId: input.runId,
        // 审计留痕（#714 升级为结构化 journal）：RPC 响应因 renderer 崩溃丢失时
        // 仍有「改了哪些文件」的可检索记录，threadId/runId 进日志关联字段
        onFileRestored: (path) => {
          writeLogRecord({
            level: "info",
            context: "coding-handlers",
            event: "coding.revert.file_restored",
            message: `revert restored ${path}`,
            threadId: input.threadId,
            runId: input.runId,
            data: { path },
          });
        },
      });
      // TOCTOU 收口：还原耗时期间用户开新 Run 会与本结果交错写同批文件，
      // 复查并告警（最小替代 in-flight 注册表，#572 review P2）
      if (isAgentRuntimeSessionActive(input.threadId)) {
        log.warn("revert completed while a new coding session became active; new-run writes may have been overwritten by restored snapshots", { threadId: input.threadId, runId: input.runId });
      }
      return result;
    },
    [AGENT_IPC_CHANNELS.REVERT_CODING_FILE]: async (params) => {
      const input = validateInput(
        codingRunFileRevertInputSchema,
        params,
        AGENT_IPC_CHANNELS.REVERT_CODING_FILE,
      );
      if (isAgentRuntimeSessionActive(input.threadId)) {
        throw new Error("Coding Run 尚未结束，无法撤销文件改动");
      }
      // 线程存在性守卫（陈旧 threadId 直接拒绝）；rootId 缺省交给服务层
      // 解析为 record.cwd——此前兜底传 agentCwd 路径会被当作 rootId 哈希查找，
      // 必然抛「找不到 Coding 根目录」（#714）
      resolveAgentThreadWorkdir(input.threadId);
      return revertCodingFileFromCheckpoint({
        sessionDir: getRuntimeCoreSessionDir(input.threadId),
        runId: input.runId,
        path: input.path,
        ...(input.rootId ? { rootId: input.rootId } : {}),
      });
    },
  };
}
