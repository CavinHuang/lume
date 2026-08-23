import { idSchema, z } from "../validation";
import { fileRefSchema as sharedFileRefSchema } from "@lume/shared";

export const relativeThreadPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !/^[a-zA-Z]:[\\/]/.test(value) &&
      !value.split(/[\\/]/).includes(".."),
    {
      message: "附件路径必须是线程内相对路径",
    },
  );

// FileRef 契约单源在 @lume/shared（#288），此处仅按 sidecar 历史命名 re-export。
export const rendererFileRefSchema = sharedFileRefSchema;

export const agentThreadIdInputSchema = z.object({
  threadId: idSchema,
});

export const workspaceSlugInputSchema = z.object({
  workspaceSlug: idSchema,
});
