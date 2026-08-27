import { idSchema, z } from "../validation";

const codingReviewSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["uncommitted", "unstaged", "staged"]) }).strict(),
  z
    .object({
      kind: z.literal("branch"),
      baseRef: z.string().trim().min(1).max(255),
    })
    .strict(),
  z
    .object({
      kind: z.literal("commit"),
      commitSha: z.string().regex(/^[a-f0-9]{40}$/),
    })
    .strict(),
]);

export const codingFileInputSchema = z.object({
  threadId: idSchema,
  path: z.string().trim().min(1),
  runId: idSchema.optional(),
  rootId: idSchema.optional(),
  reviewSource: codingReviewSourceSchema.optional(),
});

const codingDiffActionBaseSchema = z.object({
  threadId: idSchema,
  runId: idSchema.optional(),
  rootId: idSchema.optional(),
  stageFilter: z.enum(["uncommitted", "unstaged", "staged"]).optional(),
  action: z.enum(["stage", "unstage"]),
});

const codingDiffHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const codingDiffActionInputSchema = z
  .discriminatedUnion("scope", [
    codingDiffActionBaseSchema.extend({
      scope: z.literal("file"),
      path: z.string().trim().min(1),
      expectedDiffHash: codingDiffHashSchema,
    }),
    codingDiffActionBaseSchema.extend({
      scope: z.literal("hunk"),
      path: z.string().trim().min(1),
      hunkIndex: z.number().int().min(0),
      expectedDiffHash: codingDiffHashSchema,
    }),
    codingDiffActionBaseSchema.extend({
      scope: z.literal("section"),
      files: z
        .array(
          z.object({
            path: z.string().trim().min(1),
            expectedDiffHash: codingDiffHashSchema,
          }),
        )
        .min(1)
        .max(500),
    }),
  ])
  .superRefine((input, ctx) => {
    if (input.scope === "section") {
      const uniquePaths = new Set(
        input.files.map((file) => file.path.replace(/\\/g, "/")),
      );
      if (uniquePaths.size !== input.files.length) {
        ctx.addIssue({
          code: "custom",
          path: ["files"],
          message: "分区操作不能包含重复文件",
        });
      }
    }
  });

export const codingDiffMediaInputSchema = codingFileInputSchema.extend({
  side: z.enum(["before", "after"]),
});

export const codingChangeSetInputSchema = z.object({
  threadId: idSchema,
  runId: idSchema.optional(),
  paths: z.array(z.string().trim().min(1)).optional(),
  reviewSource: codingReviewSourceSchema.optional(),
});

export const codingReviewSearchInputSchema = z
  .object({
    threadId: idSchema,
    runId: idSchema.optional(),
    reviewSource: codingReviewSourceSchema.optional(),
    files: z
      .array(
        z
          .object({
            path: z.string().trim().min(1),
            rootId: idSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(2_000),
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();

export const codingRepositoryInputSchema = z.object({
  threadId: idSchema,
  runId: idSchema.optional(),
  rootId: idSchema.optional(),
});

const codingRepositoryPublishActionBaseSchema =
  codingRepositoryInputSchema.extend({
    expectedBranch: z.string().trim().min(1).max(255),
    expectedHead: z.string().regex(/^[a-f0-9]{40}$/),
  });

export const codingRepositoryPublishActionInputSchema = z.discriminatedUnion(
  "action",
  [
    codingRepositoryPublishActionBaseSchema
      .extend({
        action: z.enum(["commit", "commit_and_push"]),
        message: z.string().trim().min(1).max(5_000),
        expectedIndexHash: z.string().regex(/^[a-f0-9]{64}$/),
        includeUnstagedChanges: z.boolean().optional(),
        expectedWorktreeHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .superRefine((input, ctx) => {
        if (input.includeUnstagedChanges && !input.expectedWorktreeHash) {
          // 指纹缺席的现实成因是 worktree patch 超 16MB 水位（见 coding-change-service），
          // 文案直接给出根因与出路，避免「参数非法」式技术报错直达用户
          ctx.addIssue({
            code: "custom",
            path: ["expectedWorktreeHash"],
            message: "工作区变更超过 16MB 补丁上限，无法包含未暂存变更；请取消勾选或分次提交",
          });
        }
      }),
    codingRepositoryPublishActionBaseSchema.extend({
      action: z.literal("push"),
    }),
  ],
);

export const codingRunRevertInputSchema = z.object({
  threadId: idSchema,
  runId: idSchema,
});

export const codingRunFileRevertInputSchema = z.object({
  threadId: idSchema,
  runId: idSchema,
  path: z.string().trim().min(1),
  rootId: idSchema.optional(),
});
