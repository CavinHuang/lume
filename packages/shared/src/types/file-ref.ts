/**
 * FileRef IPC RPC payload 契约单源（#288）
 *
 * zod schema 是唯一真源：renderer/desktop 与 sidecar 双方均从本文件导入
 * 同一份 schema 与推导类型，字段增删只改这里。禁止在任何一侧再手写平行定义。
 *
 * 约束分层：
 * - 形状级约束（枚举/非空/格式）直接写在 schema 上；
 * - 场景特化约束（如 diff 评论附件的长度上限）由使用侧 `.extend()` 覆盖叠加。
 */

import { z } from "zod";

// ===== FileRef 本体 =====

export const fileSourceSchema = z.enum(["project", "session", "memory", "legacy"]);
export type FileSource = z.infer<typeof fileSourceSchema>;

/** Renderer-safe opaque file identity. Absolute paths never cross this boundary. */
export const fileRefSchema = z
  .object({
    source: fileSourceSchema,
    scopeId: z.string().trim().min(1),
    relativePath: z.string(),
  })
  .strict();
export type FileRef = z.infer<typeof fileRefSchema>;

// ===== 读结果（sidecar → renderer 出站）=====

export const fileRefTextEncodingSchema = z.enum(["utf-8", "utf-16le"]);
export type FileRefTextEncoding = z.infer<typeof fileRefTextEncodingSchema>;

export const fileRefLineEndingSchema = z.enum(["lf", "crlf", "mixed", "none"]);
export type FileRefLineEnding = z.infer<typeof fileRefLineEndingSchema>;

export const fileRefReadResultSchema = z.union([
  z
    .object({
      kind: z.literal("text"),
      content: z.string(),
      size: z.number().finite().nonnegative(),
      mtimeMs: z.number().finite(),
      mimeType: z.string(),
      encoding: fileRefTextEncodingSchema,
      bom: z.boolean(),
      lineEnding: fileRefLineEndingSchema,
      // text 分支可编辑性受权限与 10MB 上限共同决定，运行时可为 false
      editable: z.boolean(),
      truncated: z.literal(false),
    })
    .strict(),
  z
    .object({
      kind: z.enum(["binary", "too-large"]),
      size: z.number().finite().nonnegative(),
      mtimeMs: z.number().finite(),
      mimeType: z.string(),
      editable: z.literal(false),
      truncated: z.literal(true),
    })
    .strict(),
]);
export type FileRefReadResult = z.infer<typeof fileRefReadResultSchema>;

// ===== 写入（renderer → sidecar 入站 / 结果出站）=====

export const writeFileRefInputSchema = z
  .object({
    ref: fileRefSchema,
    content: z.string().max(20 * 1024 * 1024),
    expectedMtimeMs: z.number().finite().nonnegative(),
  })
  .strict();
export type WriteFileRefInput = z.infer<typeof writeFileRefInputSchema>;

export const writeFileRefResultSchema = z.union([
  z
    .object({ outcome: z.literal("saved"), mtimeMs: z.number(), size: z.number() })
    .strict(),
  z
    .object({ outcome: z.literal("conflict"), mtimeMs: z.number(), size: z.number() })
    .strict(),
]);
export type WriteFileRefResult = z.infer<typeof writeFileRefResultSchema>;

// ===== 选区编辑（renderer → sidecar 入站 / 结果出站）=====

export const fileSelectionEditInputSchema = z
  .object({
    threadId: z.string().min(1),
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
export type FileSelectionEditInput = z.infer<typeof fileSelectionEditInputSchema>;

export const fileSelectionEditResultSchema = z
  .object({ replacementText: z.string() })
  .strict();
export type FileSelectionEditResult = z.infer<typeof fileSelectionEditResultSchema>;

// ===== watch =====

export const watchFileRefResultSchema = z
  .object({ watchId: z.string() })
  .strict();
export type WatchFileRefResult = z.infer<typeof watchFileRefResultSchema>;

export const fileRefChangedEventSchema = z
  .object({
    watchId: z.string(),
    ref: fileRefSchema,
    change: z.enum(["changed", "renamed", "deleted"]),
    mtimeMs: z.number().optional(),
  })
  .strict();
export type FileRefChangedEvent = z.infer<typeof fileRefChangedEventSchema>;

// ===== guarded refs（消息内引用与普通文件树 FileRef 有意区分）=====

export const projectFileRefGuardSchema = z
  .object({
    kind: z.literal("project"),
    workspaceSlug: z.string().min(1),
    expectedProjectRootFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    consumerThreadId: z.string().min(1),
  })
  .strict();
export type ProjectFileRefGuard = z.infer<typeof projectFileRefGuardSchema>;

export const sessionFileRefGuardSchema = z
  .object({
    kind: z.literal("session"),
    consumerThreadId: z.string().min(1),
    expectedFileContextId: z.string().min(1),
  })
  .strict();
export type SessionFileRefGuard = z.infer<typeof sessionFileRefGuardSchema>;

export const guardedProjectFileRefSchema = z
  .object({
    ref: fileRefSchema.extend({ source: z.literal("project") }),
    guard: projectFileRefGuardSchema,
    expectedKind: z.enum(["file", "directory"]),
  })
  .strict();

export const guardedSessionFileRefSchema = z
  .object({
    ref: fileRefSchema.extend({ source: z.literal("session") }),
    guard: sessionFileRefGuardSchema,
    expectedKind: z.enum(["file", "directory"]),
  })
  .strict();

export const guardedFileRefSchema = z.union([
  guardedProjectFileRefSchema,
  guardedSessionFileRefSchema,
]);
export type GuardedFileRef = z.infer<typeof guardedFileRefSchema>;

// ===== binding 快照（每个 Agent 回复一个不可变快照，不含本地绝对路径）=====

export const fileReferenceBindingSchema = z
  .object({
    workspaceSlug: z.string().optional(),
    projectRootFingerprint: z.string().optional(),
    fileContextId: z.string(),
  })
  .strict();
export type FileReferenceBinding = z.infer<typeof fileReferenceBindingSchema>;
