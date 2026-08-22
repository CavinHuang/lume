import { idSchema, z } from "../validation";

const skillStorageScopeSchema = z.enum(["workspace", "project", "user"]);

export const deleteSkillInputSchema = z.object({
  workspaceSlug: idSchema,
  skillSlug: idSchema,
  storageScope: skillStorageScopeSchema.optional(),
  cwd: z.string().optional(),
});

export const listEditableSkillsInputSchema = z
  .object({
    workspaceSlug: idSchema,
    cwd: z.string().optional(),
  })
  .strict();

export const listInvocableCapabilitiesInputSchema = z
  .object({
    workspaceSlug: idSchema.optional(),
    cwd: z.string().trim().min(1).optional(),
  })
  .strict();

export const editableSkillInputSchema = z
  .object({
    workspaceSlug: idSchema,
    skillSlug: idSchema,
    storageScope: skillStorageScopeSchema,
    cwd: z.string().optional(),
  })
  .strict();

export const saveSkillInputSchema = z
  .object({
    workspaceSlug: idSchema,
    storageScope: skillStorageScopeSchema.optional(),
    cwd: z.string().optional(),
    skillSlug: z.string().trim().min(1),
    name: z.string(),
    description: z.string().optional(),
    allowedTools: z.array(z.string()).optional(),
    argumentHint: z.string().optional(),
    disableModelInvocation: z.boolean().optional(),
    version: z.string().optional(),
    prompt: z.string(),
  })
  .strict();

export const skillMarketCatalogInputSchema = z.object({
  workspaceSlug: idSchema,
  includeBlockedSources: z.boolean().optional(),
});

export const skillMarketDetailInputSchema = z.object({
  workspaceSlug: idSchema,
  skillSlug: idSchema,
});

export const skillVersionInputSchema = z.object({
  workspaceSlug: idSchema,
  skillSlug: idSchema,
  storageScope: skillStorageScopeSchema.optional(),
  cwd: z.string().optional(),
  filename: z.string().min(1).optional(),
});

export const skillImprovementAnalysisInputSchema = z.object({
  workspaceSlug: idSchema,
  skillSlug: idSchema,
  storageScope: skillStorageScopeSchema.optional(),
  cwd: z.string().optional(),
  modelRef: z.string().trim().min(1).optional(),
  maxSessions: z.number().int().min(1).max(20).optional(),
  messagesPerSession: z.number().int().min(1).max(500).optional(),
});

const skillImprovementUpdateSchema = z
  .object({
    section: z.string().min(1),
    change: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

export const applySkillImprovementInputSchema = z.object({
  workspaceSlug: idSchema,
  skillSlug: idSchema,
  storageScope: skillStorageScopeSchema.optional(),
  cwd: z.string().optional(),
  updates: z.array(skillImprovementUpdateSchema),
  modelRef: z.string().trim().min(1).optional(),
});
