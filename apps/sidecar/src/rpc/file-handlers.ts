import { AGENT_IPC_CHANNELS } from "@lume/shared";
import {
  attachWorkspaceResourceToThread,
  copyFolderToSession,
  convertLegacyFileRef,
  deleteAgentFile,
  deleteAuthorizedFileRef,
  deleteWorkspaceFile,
  deleteWorkspaceRootFile,
  exportLegacyResourceToProject,
  getAgentThreadPath,
  listAgentDirectory,
  listAuthorizedFileRefDirectory,
  listGuardedFileRefDirectory,
  listProjectDirectory,
  listWorkspaceDirectory,
  listWorkspaceRootDirectory,
  moveAgentFile,
  moveAuthorizedFileRef,
  moveWorkspaceFile,
  moveWorkspaceRootFile,
  openAgentPath,
  openProjectPath,
  openWorkspacePath,
  openWorkspaceRootPath,
  previewAgentPath,
  readAgentFileData,
  readAgentPath,
  readAuthorizedFileRef,
  writeAuthorizedFileRef,
  watchAuthorizedFileRef,
  unwatchAuthorizedFileRef,
  readGuardedFileRef,
  statAuthorizedFileRef,
  readProjectFileData,
  readProjectPath,
  previewWorkspacePath,
  promoteFileRefToProject,
  readWorkspacePath,
  readWorkspaceFileData,
  readWorkspaceRootPath,
  renameAgentFile,
  renameAuthorizedFileRef,
  resolveAuthorizedFileRef,
  resolveGuardedFileRef,
  statGuardedFileRef,
  validateGuardedFileRef,
  renameWorkspaceFile,
  renameWorkspaceRootFile,
  saveFilesToAgentThreadStreamed,
  saveFilesToWorkspace,
  saveFilesToWorkspaceRoot,
  searchAgentWorkspaceFiles,
  searchAuthorizedFiles,
  showAgentPathInFolder,
  showProjectPathInFolder,
  showWorkspacePathInFolder,
} from "../services/agent/agent-files-service";
import {
  listExternalDirEntries,
  listExternalDirs,
  removeExternalDir,
  upsertExternalDir,
} from "../services/agent/external-dirs-service";
import { promoteFileToWorkspace } from "../services/agent/agent-file-promotion-service";
import { requestFileSelectionEdit } from "../services/agent/file-selection-edit-service";
import { getAgentSubmissionStore } from "../services/agent/agent-submission-store";
import {
  attachWorkspaceResourceToThreadInputSchema,
  copyFolderToThreadInputSchema,
  externalDirAddInputSchema,
  externalDirEntriesInputSchema,
  externalDirRemoveInputSchema,
  externalDirScopeInputSchema,
  fileRefInputSchema,
  fileRefMoveInputSchema,
  fileRefRenameInputSchema,
  fileRefSearchInputSchema,
  fileRefUnwatchInputSchema,
  fileRefWriteInputSchema,
  fileSelectionEditInputSchema,
  guardedFileRefInputSchema,
  legacyFileRefConversionInputSchema,
  legacyResourceExportInputSchema,
  listDirectoryInputSchema,
  moveFileInputSchema,
  pathFileInputSchema,
  promoteFileRefInputSchema,
  promoteFileToWorkspaceInputSchema,
  renameFileInputSchema,
  saveFilesToThreadInputSchema,
  saveFilesToWorkspaceInputSchema,
  searchWorkspaceFilesInputSchema,
  threadPathInputSchema,
  workspaceMoveFileInputSchema,
  workspacePathInputSchema,
  workspaceRenameFileInputSchema,
  workspaceRequiredPathInputSchema,
} from "./schemas";
import type { NotificationWriter, RpcHandler } from "./types";
import { validateInput } from "./validation";

const activeFileSearches = new Map<string, AbortController>();

export interface FileHandlersDeps {
  writeNotification: NotificationWriter;
  resolveRequiredWorkspaceSlug: (
    threadId: string,
    workspaceSlug?: string,
  ) => string;
}

export function createFileHandlers(
  deps: FileHandlersDeps,
): Record<string, RpcHandler> {
  const { resolveRequiredWorkspaceSlug } = deps;
  return {
    [AGENT_IPC_CHANNELS.GET_THREAD_PATH]: async (params) => {
      const input = validateInput(
        threadPathInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_THREAD_PATH,
      );
      return getAgentThreadPath(
        resolveRequiredWorkspaceSlug(input.threadId, input.workspaceSlug),
        input.threadId,
      );
    },
    [AGENT_IPC_CHANNELS.LIST_DIRECTORY]: async (params) => {
      const input = validateInput(
        listDirectoryInputSchema,
        params,
        AGENT_IPC_CHANNELS.LIST_DIRECTORY,
      );
      return {
        entries: listAgentDirectory(
          resolveRequiredWorkspaceSlug(input.threadId, input.workspaceSlug),
          input.threadId,
          input.path,
        ),
      };
    },
    [AGENT_IPC_CHANNELS.LIST_WORKSPACE_DIRECTORY]: async (params) => {
      const input = validateInput(
        workspacePathInputSchema,
        params,
        AGENT_IPC_CHANNELS.LIST_WORKSPACE_DIRECTORY,
      );
      return listWorkspaceDirectory(input.workspaceSlug, input.path);
    },
    [AGENT_IPC_CHANNELS.LIST_PROJECT_DIRECTORY]: async (params) => {
      const input = validateInput(
        workspacePathInputSchema,
        params,
        AGENT_IPC_CHANNELS.LIST_PROJECT_DIRECTORY,
      );
      return listProjectDirectory(input.workspaceSlug, input.path);
    },
    [AGENT_IPC_CHANNELS.EXPORT_LEGACY_RESOURCE_TO_PROJECT]: async (params) => {
      const input = validateInput(
        legacyResourceExportInputSchema,
        params,
        AGENT_IPC_CHANNELS.EXPORT_LEGACY_RESOURCE_TO_PROJECT,
      );
      return exportLegacyResourceToProject(
        input.workspaceSlug,
        input.path,
        input.conflict,
      );
    },
    [AGENT_IPC_CHANNELS.LIST_WORKSPACE_ROOT_DIRECTORY]: async (params) => {
      const input = validateInput(
        workspacePathInputSchema,
        params,
        AGENT_IPC_CHANNELS.LIST_WORKSPACE_ROOT_DIRECTORY,
      );
      return listWorkspaceRootDirectory(input.workspaceSlug, input.path);
    },
    [AGENT_IPC_CHANNELS.DELETE_FILE]: async (params) => {
      const input = validateInput(
        pathFileInputSchema,
        params,
        AGENT_IPC_CHANNELS.DELETE_FILE,
      );
      return deleteAgentFile(
        resolveRequiredWorkspaceSlug(input.threadId, input.workspaceSlug),
        input.threadId,
        input.path,
      );
    },
    [AGENT_IPC_CHANNELS.DELETE_WORKSPACE_FILE]: async (params) => {
      const input = validateInput(
        workspaceRequiredPathInputSchema,
        params,
        AGENT_IPC_CHANNELS.DELETE_WORKSPACE_FILE,
      );
      return deleteWorkspaceFile(input.workspaceSlug, input.path);
    },
    [AGENT_IPC_CHANNELS.DELETE_WORKSPACE_ROOT_FILE]: async (params) => {
      const input = validateInput(
        workspaceRequiredPathInputSchema,
        params,
        AGENT_IPC_CHANNELS.DELETE_WORKSPACE_ROOT_FILE,
      );
      return deleteWorkspaceRootFile(input.workspaceSlug, input.path);
    },
    [AGENT_IPC_CHANNELS.OPEN_FILE]: async (params) => {
      const input = validateInput(
        pathFileInputSchema,
        params,
        AGENT_IPC_CHANNELS.OPEN_FILE,
      );
      return openAgentPath(
        resolveRequiredWorkspaceSlug(input.threadId, input.workspaceSlug),
        input.threadId,
        input.path,
      );
    },
    [AGENT_IPC_CHANNELS.OPEN_WORKSPACE_FILE]: async (params) => {
      const input = validateInput(
        workspaceRequiredPathInputSchema,
        params,
        AGENT_IPC_CHANNELS.OPEN_WORKSPACE_FILE,
      );
      return openWorkspacePath(input.workspaceSlug, input.path);
    },
    [AGENT_IPC_CHANNELS.OPEN_PROJECT_FILE]: async (params) => {
      const input = validateInput(
        workspaceRequiredPathInputSchema,
        params,
        AGENT_IPC_CHANNELS.OPEN_PROJECT_FILE,
      );
      return openProjectPath(input.workspaceSlug, input.path);
    },
    [AGENT_IPC_CHANNELS.OPEN_WORKSPACE_ROOT_FILE]: async (params) => {
      const input = validateInput(
        workspaceRequiredPathInputSchema,
        params,
        AGENT_IPC_CHANNELS.OPEN_WORKSPACE_ROOT_FILE,
      );
      return openWorkspaceRootPath(input.workspaceSlug, input.path);
    },
    [AGENT_IPC_CHANNELS.SHOW_IN_FOLDER]: async (params) => {
      const input = validateInput(
        pathFileInputSchema,
        params,
        AGENT_IPC_CHANNELS.SHOW_IN_FOLDER,
      );
      return showAgentPathInFolder(
        resolveRequiredWorkspaceSlug(input.threadId, input.workspaceSlug),
        input.threadId,
        input.path,
      );
    },
    [AGENT_IPC_CHANNELS.SHOW_WORKSPACE_IN_FOLDER]: async (params) => {
      const input = validateInput(
        workspaceRequiredPathInputSchema,
        params,
        AGENT_IPC_CHANNELS.SHOW_WORKSPACE_IN_FOLDER,
      );
      return showWorkspacePathInFolder(input.workspaceSlug, input.path);
    },
    [AGENT_IPC_CHANNELS.SHOW_PROJECT_IN_FOLDER]: async (params) => {
      const input = validateInput(
        workspaceRequiredPathInputSchema,
        params,
        AGENT_IPC_CHANNELS.SHOW_PROJECT_IN_FOLDER,
      );
      return showProjectPathInFolder(input.workspaceSlug, input.path);
    },
    [AGENT_IPC_CHANNELS.PREVIEW_FILE]: async (params) => {
      const input = validateInput(
        pathFileInputSchema,
        params,
        AGENT_IPC_CHANNELS.PREVIEW_FILE,
      );
      return previewAgentPath(
        resolveRequiredWorkspaceSlug(input.threadId, input.workspaceSlug),
        input.threadId,
        input.path,
      );
    },
    [AGENT_IPC_CHANNELS.READ_FILE]: async (params) => {
      const input = validateInput(
        pathFileInputSchema,
        params,
        AGENT_IPC_CHANNELS.READ_FILE,
      );
      return readAgentPath(
        resolveRequiredWorkspaceSlug(input.threadId, input.workspaceSlug),
        input.threadId,
        input.path,
      );
    },
    [AGENT_IPC_CHANNELS.READ_THREAD_FILE_DATA]: async (params) => {
      const input = validateInput(
        pathFileInputSchema,
        params,
        AGENT_IPC_CHANNELS.READ_THREAD_FILE_DATA,
      );
      return readAgentFileData(
        resolveRequiredWorkspaceSlug(input.threadId, input.workspaceSlug),
        input.threadId,
        input.path,
      );
    },
    [AGENT_IPC_CHANNELS.PREVIEW_WORKSPACE_FILE]: async (params) => {
      const input = validateInput(
        workspaceRequiredPathInputSchema,
        params,
        AGENT_IPC_CHANNELS.PREVIEW_WORKSPACE_FILE,
      );
      return previewWorkspacePath(input.workspaceSlug, input.path);
    },
    [AGENT_IPC_CHANNELS.READ_WORKSPACE_FILE]: async (params) => {
      const input = validateInput(
        workspaceRequiredPathInputSchema,
        params,
        AGENT_IPC_CHANNELS.READ_WORKSPACE_FILE,
      );
      return readWorkspacePath(input.workspaceSlug, input.path);
    },
    [AGENT_IPC_CHANNELS.READ_WORKSPACE_FILE_DATA]: async (params) => {
      const input = validateInput(
        workspaceRequiredPathInputSchema,
        params,
        AGENT_IPC_CHANNELS.READ_WORKSPACE_FILE_DATA,
      );
      return readWorkspaceFileData(input.workspaceSlug, input.path);
    },
    [AGENT_IPC_CHANNELS.READ_PROJECT_FILE]: async (params) => {
      const input = validateInput(
        workspaceRequiredPathInputSchema,
        params,
        AGENT_IPC_CHANNELS.READ_PROJECT_FILE,
      );
      return readProjectPath(input.workspaceSlug, input.path);
    },
    [AGENT_IPC_CHANNELS.READ_PROJECT_FILE_DATA]: async (params) => {
      const input = validateInput(
        workspaceRequiredPathInputSchema,
        params,
        AGENT_IPC_CHANNELS.READ_PROJECT_FILE_DATA,
      );
      return readProjectFileData(input.workspaceSlug, input.path);
    },
    [AGENT_IPC_CHANNELS.READ_WORKSPACE_ROOT_FILE]: async (params) => {
      const input = validateInput(
        workspaceRequiredPathInputSchema,
        params,
        AGENT_IPC_CHANNELS.READ_WORKSPACE_ROOT_FILE,
      );
      return readWorkspaceRootPath(input.workspaceSlug, input.path);
    },
    [AGENT_IPC_CHANNELS.RENAME_FILE]: async (params) => {
      const input = validateInput(
        renameFileInputSchema,
        params,
        AGENT_IPC_CHANNELS.RENAME_FILE,
      );
      return renameAgentFile(
        resolveRequiredWorkspaceSlug(input.threadId, input.workspaceSlug),
        input.threadId,
        input.path,
        input.newName,
      );
    },
    [AGENT_IPC_CHANNELS.RENAME_WORKSPACE_FILE]: async (params) => {
      const input = validateInput(
        workspaceRenameFileInputSchema,
        params,
        AGENT_IPC_CHANNELS.RENAME_WORKSPACE_FILE,
      );
      return renameWorkspaceFile(
        input.workspaceSlug,
        input.path,
        input.newName,
      );
    },
    [AGENT_IPC_CHANNELS.RENAME_WORKSPACE_ROOT_FILE]: async (params) => {
      const input = validateInput(
        workspaceRenameFileInputSchema,
        params,
        AGENT_IPC_CHANNELS.RENAME_WORKSPACE_ROOT_FILE,
      );
      return renameWorkspaceRootFile(
        input.workspaceSlug,
        input.path,
        input.newName,
      );
    },
    [AGENT_IPC_CHANNELS.MOVE_FILE]: async (params) => {
      const input = validateInput(
        moveFileInputSchema,
        params,
        AGENT_IPC_CHANNELS.MOVE_FILE,
      );
      return moveAgentFile(
        resolveRequiredWorkspaceSlug(input.threadId, input.workspaceSlug),
        input.threadId,
        input.path,
        input.targetDir,
      );
    },
    [AGENT_IPC_CHANNELS.MOVE_WORKSPACE_FILE]: async (params) => {
      const input = validateInput(
        workspaceMoveFileInputSchema,
        params,
        AGENT_IPC_CHANNELS.MOVE_WORKSPACE_FILE,
      );
      return moveWorkspaceFile(
        input.workspaceSlug,
        input.path,
        input.targetDir,
      );
    },
    [AGENT_IPC_CHANNELS.MOVE_WORKSPACE_ROOT_FILE]: async (params) => {
      const input = validateInput(
        workspaceMoveFileInputSchema,
        params,
        AGENT_IPC_CHANNELS.MOVE_WORKSPACE_ROOT_FILE,
      );
      return moveWorkspaceRootFile(
        input.workspaceSlug,
        input.path,
        input.targetDir,
      );
    },
    [AGENT_IPC_CHANNELS.PROMOTE_FILE_TO_WORKSPACE]: async (params) =>
      promoteFileToWorkspace(
        validateInput(
          promoteFileToWorkspaceInputSchema,
          params,
          AGENT_IPC_CHANNELS.PROMOTE_FILE_TO_WORKSPACE,
        ),
      ),
    [AGENT_IPC_CHANNELS.SEARCH_WORKSPACE_FILES]: async (params) => {
      const input = validateInput(
        searchWorkspaceFilesInputSchema,
        params,
        AGENT_IPC_CHANNELS.SEARCH_WORKSPACE_FILES,
      );
      const workspaceSlug = resolveRequiredWorkspaceSlug(
        input.threadId,
        input.workspaceSlug,
      );
      return searchAgentWorkspaceFiles(
        workspaceSlug,
        input.threadId,
        input.query,
        input.limit ?? 20,
        input.rootPath,
      );
    },
    [AGENT_IPC_CHANNELS.LIST_FILE_REF_DIRECTORY]: async (params) => {
      const input = validateInput(
        fileRefInputSchema,
        params,
        AGENT_IPC_CHANNELS.LIST_FILE_REF_DIRECTORY,
      );
      return listAuthorizedFileRefDirectory(input.ref);
    },
    [AGENT_IPC_CHANNELS.READ_FILE_REF]: async (params) => {
      const input = validateInput(
        fileRefInputSchema,
        params,
        AGENT_IPC_CHANNELS.READ_FILE_REF,
      );
      return readAuthorizedFileRef(input.ref);
    },
    [AGENT_IPC_CHANNELS.WRITE_FILE_REF]: async (params) => {
      const input = validateInput(
        fileRefWriteInputSchema,
        params,
        AGENT_IPC_CHANNELS.WRITE_FILE_REF,
      );
      return writeAuthorizedFileRef(input);
    },
    [AGENT_IPC_CHANNELS.REQUEST_FILE_SELECTION_EDIT]: async (params) => {
      const input = validateInput(
        fileSelectionEditInputSchema,
        params,
        AGENT_IPC_CHANNELS.REQUEST_FILE_SELECTION_EDIT,
      );
      const authorized = readAuthorizedFileRef(input.ref);
      if (authorized.kind !== "text" || !authorized.editable) {
        throw new Error("当前文件不可编辑，无法请求模型修改");
      }
      return requestFileSelectionEdit(input);
    },
    [AGENT_IPC_CHANNELS.WATCH_FILE_REF]: async (params) => {
      const input = validateInput(
        fileRefInputSchema,
        params,
        AGENT_IPC_CHANNELS.WATCH_FILE_REF,
      );
      return watchAuthorizedFileRef(input.ref, deps.writeNotification);
    },
    [AGENT_IPC_CHANNELS.UNWATCH_FILE_REF]: async (params) => {
      const input = validateInput(
        fileRefUnwatchInputSchema,
        params,
        AGENT_IPC_CHANNELS.UNWATCH_FILE_REF,
      );
      return unwatchAuthorizedFileRef(input.watchId);
    },
    [AGENT_IPC_CHANNELS.STAT_FILE_REF]: async (params) => {
      const input = validateInput(
        fileRefInputSchema,
        params,
        AGENT_IPC_CHANNELS.STAT_FILE_REF,
      );
      return statAuthorizedFileRef(input.ref);
    },
    [AGENT_IPC_CHANNELS.SEARCH_FILE_REFS]: async (params) => {
      const input = validateInput(
        fileRefSearchInputSchema,
        params,
        AGENT_IPC_CHANNELS.SEARCH_FILE_REFS,
      );
      const key = `${input.ref.source}:${input.ref.scopeId}`;
      activeFileSearches.get(key)?.abort();
      const controller = new AbortController();
      activeFileSearches.set(key, controller);
      try {
        return await searchAuthorizedFiles(input.ref, input.query, {
          includeExcluded: input.includeExcluded,
          limit: input.limit,
          signal: controller.signal,
        });
      } finally {
        if (activeFileSearches.get(key) === controller)
          activeFileSearches.delete(key);
      }
    },
    [AGENT_IPC_CHANNELS.RESOLVE_FILE_REF]: async (params) => {
      const input = validateInput(
        fileRefInputSchema,
        params,
        AGENT_IPC_CHANNELS.RESOLVE_FILE_REF,
      );
      const resolved = resolveAuthorizedFileRef(input.ref);
      return {
        path: resolved.absolutePath,
        relativePath: resolved.relativePath,
      };
    },
    [AGENT_IPC_CHANNELS.RENAME_FILE_REF]: async (params) => {
      const input = validateInput(
        fileRefRenameInputSchema,
        params,
        AGENT_IPC_CHANNELS.RENAME_FILE_REF,
      );
      return renameAuthorizedFileRef(input.ref, input.newName);
    },
    [AGENT_IPC_CHANNELS.PROMOTE_FILE_REF_TO_PROJECT]: async (params) => {
      const input = validateInput(
        promoteFileRefInputSchema,
        params,
        AGENT_IPC_CHANNELS.PROMOTE_FILE_REF_TO_PROJECT,
      );
      return promoteFileRefToProject(input.ref, input.workspaceSlug);
    },
    [AGENT_IPC_CHANNELS.LIST_EXTERNAL_DIRS]: async (params) => {
      const input = validateInput(
        externalDirScopeInputSchema,
        params,
        AGENT_IPC_CHANNELS.LIST_EXTERNAL_DIRS,
      );
      return listExternalDirs(input);
    },
    [AGENT_IPC_CHANNELS.ADD_EXTERNAL_DIR]: async (params) => {
      const input = validateInput(
        externalDirAddInputSchema,
        params,
        AGENT_IPC_CHANNELS.ADD_EXTERNAL_DIR,
      );
      upsertExternalDir(input, input.absolutePath);
    },
    [AGENT_IPC_CHANNELS.REMOVE_EXTERNAL_DIR]: async (params) => {
      const input = validateInput(
        externalDirRemoveInputSchema,
        params,
        AGENT_IPC_CHANNELS.REMOVE_EXTERNAL_DIR,
      );
      removeExternalDir(input, input.absolutePath);
    },
    [AGENT_IPC_CHANNELS.LIST_EXTERNAL_DIR_ENTRIES]: async (params) => {
      const input = validateInput(
        externalDirEntriesInputSchema,
        params,
        AGENT_IPC_CHANNELS.LIST_EXTERNAL_DIR_ENTRIES,
      );
      return listExternalDirEntries(input, input.absolutePath);
    },
    [AGENT_IPC_CHANNELS.MOVE_FILE_REF]: async (params) => {
      const input = validateInput(
        fileRefMoveInputSchema,
        params,
        AGENT_IPC_CHANNELS.MOVE_FILE_REF,
      );
      return moveAuthorizedFileRef(input.ref, input.targetDirectory);
    },
    [AGENT_IPC_CHANNELS.DELETE_FILE_REF]: async (params) => {
      const input = validateInput(
        fileRefInputSchema,
        params,
        AGENT_IPC_CHANNELS.DELETE_FILE_REF,
      );
      return deleteAuthorizedFileRef(input.ref);
    },
    [AGENT_IPC_CHANNELS.CONVERT_LEGACY_FILE_REF]: async (params) => {
      const input = validateInput(
        legacyFileRefConversionInputSchema,
        params,
        AGENT_IPC_CHANNELS.CONVERT_LEGACY_FILE_REF,
      );
      return convertLegacyFileRef(input);
    },
    [AGENT_IPC_CHANNELS.VALIDATE_GUARDED_FILE_REF]: async (params) => {
      const input = validateInput(
        guardedFileRefInputSchema,
        params,
        AGENT_IPC_CHANNELS.VALIDATE_GUARDED_FILE_REF,
      );
      return validateGuardedFileRef(input.guardedRef);
    },
    [AGENT_IPC_CHANNELS.LIST_GUARDED_FILE_REF_DIRECTORY]: async (params) => {
      const input = validateInput(
        guardedFileRefInputSchema,
        params,
        AGENT_IPC_CHANNELS.LIST_GUARDED_FILE_REF_DIRECTORY,
      );
      return listGuardedFileRefDirectory(input.guardedRef);
    },
    [AGENT_IPC_CHANNELS.STAT_GUARDED_FILE_REF]: async (params) => {
      const input = validateInput(
        guardedFileRefInputSchema,
        params,
        AGENT_IPC_CHANNELS.STAT_GUARDED_FILE_REF,
      );
      return statGuardedFileRef(input.guardedRef);
    },
    [AGENT_IPC_CHANNELS.READ_GUARDED_FILE_REF]: async (params) => {
      const input = validateInput(
        guardedFileRefInputSchema,
        params,
        AGENT_IPC_CHANNELS.READ_GUARDED_FILE_REF,
      );
      return readGuardedFileRef(input.guardedRef);
    },
    [AGENT_IPC_CHANNELS.RESOLVE_GUARDED_FILE_REF]: async (params) => {
      const input = validateInput(
        guardedFileRefInputSchema,
        params,
        AGENT_IPC_CHANNELS.RESOLVE_GUARDED_FILE_REF,
      );
      const resolved = resolveGuardedFileRef(input.guardedRef);
      return {
        path: resolved.absolutePath,
        relativePath: resolved.relativePath,
      };
    },
    [AGENT_IPC_CHANNELS.SAVE_FILES_TO_THREAD]: async (params) => {
      const input = validateInput(
        saveFilesToThreadInputSchema,
        params,
        AGENT_IPC_CHANNELS.SAVE_FILES_TO_THREAD,
      );
      if (input.clientSubmissionId) {
        const prepared = getAgentSubmissionStore().getPreparedAttachmentFiles(
          input.clientSubmissionId,
        );
        if (prepared.length > 0) return prepared;
      }
      const saved = await saveFilesToAgentThreadStreamed({
        ...input,
        workspaceSlug: resolveRequiredWorkspaceSlug(
          input.threadId,
          input.workspaceSlug,
        ),
      });
      if (input.clientSubmissionId) {
        getAgentSubmissionStore().prepareAttachmentLease(
          input.clientSubmissionId,
          input.threadId,
          saved,
        );
      }
      return saved;
    },
    [AGENT_IPC_CHANNELS.COPY_FOLDER_TO_THREAD]: async (params) =>
      copyFolderToSession(
        (() => {
          const input = validateInput(
            copyFolderToThreadInputSchema,
            params,
            AGENT_IPC_CHANNELS.COPY_FOLDER_TO_THREAD,
          );
          return {
            ...input,
            workspaceSlug: resolveRequiredWorkspaceSlug(
              input.threadId,
              input.workspaceSlug,
            ),
          };
        })(),
      ),
    [AGENT_IPC_CHANNELS.ATTACH_WORKSPACE_RESOURCE_TO_THREAD]: async (params) =>
      attachWorkspaceResourceToThread(
        validateInput(
          attachWorkspaceResourceToThreadInputSchema,
          params,
          AGENT_IPC_CHANNELS.ATTACH_WORKSPACE_RESOURCE_TO_THREAD,
        ),
      ),
    [AGENT_IPC_CHANNELS.SAVE_FILES_TO_WORKSPACE]: async (params) =>
      saveFilesToWorkspace(
        validateInput(
          saveFilesToWorkspaceInputSchema,
          params,
          AGENT_IPC_CHANNELS.SAVE_FILES_TO_WORKSPACE,
        ),
      ),
    [AGENT_IPC_CHANNELS.SAVE_FILES_TO_WORKSPACE_ROOT]: async (params) =>
      saveFilesToWorkspaceRoot(
        validateInput(
          saveFilesToWorkspaceInputSchema,
          params,
          AGENT_IPC_CHANNELS.SAVE_FILES_TO_WORKSPACE_ROOT,
        ),
      ),
  };
}
