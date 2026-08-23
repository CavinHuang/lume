import {
  AGENT_ATTACHMENT_LIMITS,
  fileSelectionEditInputSchema,
  guardedFileRefSchema,
  writeFileRefInputSchema,
} from "@lume/shared";
import { idSchema, optionalIdSchema, z } from "../validation";
import { rendererFileRefSchema } from "./shared";

// FileRef 写入/选区编辑/guarded 契约单源在 @lume/shared（#288），按 sidecar 历史命名转发。
export {
  writeFileRefInputSchema as fileRefWriteInputSchema,
  fileSelectionEditInputSchema,
  guardedFileRefSchema,
};

export const workspacePathInputSchema = z.object({
  workspaceSlug: idSchema,
  path: z.string().optional(),
});

export const legacyResourceExportInputSchema = z.object({
  workspaceSlug: idSchema,
  path: idSchema,
  conflict: z.literal("error"),
});
export const workspaceRequiredPathInputSchema = z.object({
  workspaceSlug: idSchema,
  path: idSchema,
});

export const workspaceRenameFileInputSchema = z.object({
  workspaceSlug: idSchema,
  path: idSchema,
  newName: z.string().min(1),
});

export const workspaceMoveFileInputSchema = z.object({
  workspaceSlug: idSchema,
  path: idSchema,
  targetDir: idSchema,
});

export const threadPathInputSchema = z.object({
  workspaceSlug: optionalIdSchema,
  threadId: idSchema,
});

export const listDirectoryInputSchema = z.object({
  workspaceSlug: optionalIdSchema,
  threadId: idSchema,
  path: z.string().optional(),
});

export const pathFileInputSchema = z.object({
  workspaceSlug: optionalIdSchema,
  threadId: idSchema,
  path: idSchema,
});

export const fileRefSchema = rendererFileRefSchema;

export const fileRefInputSchema = z.object({ ref: fileRefSchema }).strict();
export const fileRefUnwatchInputSchema = z
  .object({ watchId: z.string().uuid() })
  .strict();
export const guardedFileRefInputSchema = z
  .object({ guardedRef: guardedFileRefSchema })
  .strict();
export const fileRefSearchInputSchema = z
  .object({
    ref: fileRefSchema,
    query: z.string().default(""),
    includeExcluded: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();
export const fileRefRenameInputSchema = z
  .object({ ref: fileRefSchema, newName: z.string().min(1) })
  .strict();
export const fileRefMoveInputSchema = z
  .object({ ref: fileRefSchema, targetDirectory: fileRefSchema })
  .strict();
export const promoteFileRefInputSchema = z
  .object({ ref: fileRefSchema, workspaceSlug: idSchema })
  .strict();
const externalDirThreadScopeSchema = z
  .object({
    kind: z.literal("thread"),
    workspaceSlug: idSchema,
    threadId: idSchema,
    fileContextId: optionalIdSchema,
  })
  .strict();
const externalDirWorkspaceScopeSchema = z
  .object({
    kind: z.literal("workspace"),
    workspaceSlug: idSchema,
  })
  .strict();
export const externalDirScopeInputSchema = z.discriminatedUnion("kind", [
  externalDirThreadScopeSchema,
  externalDirWorkspaceScopeSchema,
]);
const externalDirPathSchema = z.string().min(1).max(4096);
export const externalDirAddInputSchema = z.discriminatedUnion("kind", [
  externalDirThreadScopeSchema
    .extend({ absolutePath: externalDirPathSchema })
    .strict(),
  externalDirWorkspaceScopeSchema
    .extend({ absolutePath: externalDirPathSchema })
    .strict(),
]);
export const externalDirRemoveInputSchema = externalDirAddInputSchema;
// 列举必须携带 scope：service 校验 absolutePath 命中该 scope 注册表（自身或后代）后才列举
export const externalDirEntriesInputSchema = z.discriminatedUnion("kind", [
  externalDirThreadScopeSchema
    .extend({ absolutePath: externalDirPathSchema })
    .strict(),
  externalDirWorkspaceScopeSchema
    .extend({ absolutePath: externalDirPathSchema })
    .strict(),
]);
export const legacyFileRefConversionInputSchema = z.discriminatedUnion(
  "recordKind",
  [
    z
      .object({
        recordKind: z.literal("thread-attachment"),
        threadId: idSchema,
        workspaceSlug: optionalIdSchema,
        legacyRelativePath: z.string().min(1),
      })
      .strict(),
    z
      .object({
        recordKind: z.literal("memory-source"),
        workspaceSlug: idSchema,
        legacyRelativePath: z.string().min(1),
      })
      .strict(),
  ],
);

export const renameFileInputSchema = z.object({
  workspaceSlug: optionalIdSchema,
  threadId: idSchema,
  path: idSchema,
  newName: z.string().min(1),
});

export const moveFileInputSchema = z.object({
  workspaceSlug: optionalIdSchema,
  threadId: idSchema,
  path: idSchema,
  targetDir: idSchema,
});

export const promoteFileToWorkspaceInputSchema = z.object({
  workspaceSlug: idSchema,
  threadId: idSchema,
  filePath: idSchema,
  conflictMode: z.enum(["overwrite", "rename"]).optional(),
});

export const searchWorkspaceFilesInputSchema = z.object({
  workspaceSlug: optionalIdSchema,
  threadId: idSchema,
  query: z.string().default(""),
  limit: z.number().int().min(1).max(200).optional(),
  rootPath: z.string().optional(),
});

// 单文件 base64 上限（25MB × 4/3 + padding 余量）；批总量对齐 service 层 maxTotalBytes 限额
const attachmentTotalBytesRefine = (files: Array<{ data?: string }>) =>
  files.reduce((total, file) => total + (file.data?.length ?? 0), 0) <=
  Math.ceil((AGENT_ATTACHMENT_LIMITS.maxTotalBytes * 4) / 3);

export const saveFilesToThreadInputSchema = z
  .object({
    workspaceSlug: optionalIdSchema,
    threadId: idSchema,
    clientSubmissionId: idSchema.optional(),
    files: z
      .array(
        z
          .object({
            id: idSchema.optional(),
            filename: z.string().min(1),
            mediaType: z.string().min(1).optional(),
            size: z
              .number()
              .int()
              .min(0)
              .max(AGENT_ATTACHMENT_LIMITS.maxFileBytes)
              .optional(),
            data: z
              .string()
              .max(Math.ceil((AGENT_ATTACHMENT_LIMITS.maxFileBytes * 4) / 3) + 4)
              .optional(),
            sourcePath: z.string().min(1).optional(),
          })
          .refine((file) => file.data !== undefined || !!file.sourcePath, {
            message: "文件必须提供 data 或 sourcePath",
          }),
      )
      .max(AGENT_ATTACHMENT_LIMITS.maxCount),
  })
  .refine(({ files }) => attachmentTotalBytesRefine(files), {
    message: `附件总大小超过 ${Math.floor(AGENT_ATTACHMENT_LIMITS.maxTotalBytes / 1024 / 1024)}MB 上限`,
  });

export const saveFilesToWorkspaceInputSchema = z
  .object({
    workspaceSlug: idSchema,
    files: z
      .array(
        z
          .object({
            filename: z.string().min(1),
            data: z
              .string()
              .max(Math.ceil((AGENT_ATTACHMENT_LIMITS.maxFileBytes * 4) / 3) + 4)
              .optional(),
            sourcePath: z.string().min(1).optional(),
          })
          .refine((file) => !!file.data || !!file.sourcePath, {
            message: "文件必须提供 data 或 sourcePath",
          }),
      )
      .max(AGENT_ATTACHMENT_LIMITS.maxCount),
  })
  .refine(({ files }) => attachmentTotalBytesRefine(files), {
    message: `附件总大小超过 ${Math.floor(AGENT_ATTACHMENT_LIMITS.maxTotalBytes / 1024 / 1024)}MB 上限`,
  });

export const copyFolderToThreadInputSchema = z.object({
  sourcePath: idSchema,
  workspaceSlug: optionalIdSchema,
  threadId: idSchema,
});

export const attachWorkspaceResourceToThreadInputSchema = z.object({
  workspaceSlug: idSchema,
  threadId: idSchema,
  sourcePath: idSchema,
});
