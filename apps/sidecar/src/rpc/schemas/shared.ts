import { idSchema, z } from "../validation";

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

export const rendererFileRefSchema = z
  .object({
    source: z.enum(["project", "session", "memory", "legacy"]),
    scopeId: z.string().trim().min(1),
    relativePath: z.string(),
  })
  .strict();

export const agentThreadIdInputSchema = z.object({
  threadId: idSchema,
});

export const workspaceSlugInputSchema = z.object({
  workspaceSlug: idSchema,
});
