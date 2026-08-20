import { AGENT_ATTACHMENT_LIMITS } from "@lume/shared";
import { idSchema, optionalIdSchema, z } from "../validation";
import { rendererFileRefSchema } from "./shared";

const guardedProjectFileRefSchema = z
  .object({
    ref: rendererFileRefSchema
      .extend({ source: z.literal("project") })
      .strict(),
    expectedKind: z.enum(["file", "directory"]),
    guard: z
      .object({
        kind: z.literal("project"),
        workspaceSlug: idSchema,
        expectedProjectRootFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        consumerThreadId: idSchema,
      })
      .strict(),
  })
  .strict();

const guardedSessionFileRefSchema = z
  .object({
    ref: rendererFileRefSchema
      .extend({ source: z.literal("session") })
      .strict(),
    expectedKind: z.enum(["file", "directory"]),
    guard: z
      .object({
        kind: z.literal("session"),
        consumerThreadId: idSchema,
        expectedFileContextId: idSchema,
      })
      .strict(),
  })
  .strict();

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
export const fileRefWriteInputSchema = z
  .object({
    ref: fileRefSchema,
    content: z.string().max(20 * 1024 * 1024),
    expectedMtimeMs: z.number().finite().nonnegative(),
  })
  .strict();
export const fileSelectionEditInputSchema = z
  .object({
    threadId: idSchema,
    ref: fileRefSchema,
    content: z.string().max(10 * 1024 * 1024),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
    instruction: z.string().trim().min(1).max(4_000),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (
      input.endOffset < input.startOffset ||
      input.endOffset > input.content.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["endOffset"],
        message: "选区范围无效",
      });
      return;
    }
    if (input.endOffset - input.startOffset > 32 * 1024) {
      ctx.addIssue({
        code: "custom",
        path: ["endOffset"],
        message: "选区不能超过 32 KB",
      });
    }
  });
export const fileRefUnwatchInputSchema = z
  .object({ watchId: z.string().uuid() })
  .strict();
export const guardedFileRefSchema = z.union([
  guardedProjectFileRefSchema,
  guardedSessionFileRefSchema,
]);
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
export const externalDirEntriesInputSchema = z
  .object({ absolutePath: externalDirPathSchema })
  .strict();
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

export const saveFilesToThreadInputSchema = z.object({
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
});

export const saveFilesToWorkspaceInputSchema = z.object({
  workspaceSlug: idSchema,
  files: z.array(
    z
      .object({
        filename: z.string().min(1),
        data: z.string().optional(),
        sourcePath: z.string().min(1).optional(),
      })
      .refine((file) => !!file.data || !!file.sourcePath, {
        message: "文件必须提供 data 或 sourcePath",
      }),
  ),
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
