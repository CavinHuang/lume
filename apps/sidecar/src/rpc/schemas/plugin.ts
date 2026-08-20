import type {
  InspectMarketSourceRef,
  PluginSourceRef,
  SkillMarketSourceRef,
} from "@lume/shared";
import { idSchema, z } from "../validation";

export const githubSkillReviewInputSchema = z.object({
  url: z.string().url(),
});

export const installGitHubSkillInputSchema = z.object({
  url: z.string().url(),
  workspaceSlug: idSchema,
  reviewToken: z.string().min(1),
  overwrite: z.boolean().optional(),
});

export const importLocalSkillDirectoryInputSchema = z.object({
  workspaceSlug: idSchema,
  localPath: z.string().min(1),
  overwrite: z.boolean().optional(),
});

export const installSkillMarketItemInputSchema = z.object({
  workspaceSlug: idSchema,
  skillId: z.string().min(1),
  overwrite: z.boolean().optional(),
});

const pluginSourceRefSchema: z.ZodType<PluginSourceRef> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("local"),
        path: z.string().trim().min(1),
      })
      .strict(),
    z
      .object({
        type: z.literal("github"),
        owner: idSchema,
        repo: idSchema,
        ref: z.string().trim().min(1),
        url: z.string().url(),
        subdir: z.string().trim().min(1).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("subscribed-market"),
        sourceId: idSchema,
        itemId: z.string().trim().min(1),
        resolved: pluginSourceRefSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("legacy"),
        path: z.string().trim().min(1),
      })
      .strict(),
  ]),
);

const skillMarketSourceRefSchema: z.ZodType<SkillMarketSourceRef> =
  z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("skill-local"),
        path: z.string().trim().min(1),
      })
      .strict(),
    z
      .object({
        type: z.literal("skill-github"),
        url: z.string().url(),
      })
      .strict(),
  ]);

const inspectMarketSourceRefSchema: z.ZodType<InspectMarketSourceRef> = z.union(
  [
    pluginSourceRefSchema,
    skillMarketSourceRefSchema,
    z
      .object({
        type: z.literal("market-item"),
        sourceId: idSchema,
        itemId: z.string().trim().min(1),
      })
      .strict(),
  ],
);

export const marketCatalogInputSchema = z
  .object({
    workspaceSlug: idSchema,
    includeBlockedSources: z.boolean().optional(),
    cacheMode: z.enum(["cache-first", "force-refresh"]).optional(),
  })
  .strict();

export const preparePluginPackageInputSchema = z
  .object({
    workspaceSlug: idSchema,
    catalogItemKey: z.string().trim().min(1).max(512),
    setupStepId: z.string().trim().min(1).max(128),
  })
  .strict();

const pluginPackageOwnerSchema = z
  .object({
    ownerWebContentsId: z.number().int().nonnegative(),
    ownerGeneration: z.number().int().nonnegative(),
  })
  .strict();

export const privilegedPreparePluginPackageInputSchema = z
  .object({
    credential: z.string().min(1),
    request: preparePluginPackageInputSchema
      .extend(pluginPackageOwnerSchema.shape)
      .strict(),
  })
  .strict();

export const privilegedFinalizePluginPackageInputSchema = z
  .object({
    credential: z.string().min(1),
    request: z
      .object({
        token: z.string().trim().min(16).max(128),
        ownerWebContentsId: z.number().int().nonnegative(),
        ownerGeneration: z.number().int().nonnegative(),
        targetPath: z.string().trim().min(1),
        overwrite: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

export const privilegedRevokePluginPackageInputSchema = z
  .object({
    credential: z.string().min(1),
    request: z
      .object({
        token: z.string().trim().min(16).max(128),
        ownerWebContentsId: z.number().int().nonnegative(),
        ownerGeneration: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const marketDetailInputSchema = z
  .object({
    workspaceSlug: idSchema,
    kind: z.enum(["plugin", "skill"]),
    itemId: z.string().trim().min(1),
  })
  .strict();

export const inspectMarketSourceInputSchema = z
  .object({
    workspaceSlug: idSchema,
    source: inspectMarketSourceRefSchema,
  })
  .strict();

export const installMarketItemInputSchema = z
  .object({
    workspaceSlug: idSchema,
    kind: z.enum(["plugin", "skill"]),
    itemId: z.string().trim().min(1).optional(),
    source: inspectMarketSourceRefSchema.optional(),
    overwrite: z.boolean().optional(),
    enableScope: z.enum(["none", "workspace", "global"]).optional(),
    acceptedPermissionsHash: z.string().trim().min(1).optional(),
  })
  .strict();

export const updatePluginInputSchema = z
  .object({
    workspaceSlug: idSchema,
    pluginId: idSchema,
    source: pluginSourceRefSchema.optional(),
    targetVersion: z.string().trim().min(1).optional(),
    acceptedPermissionsHash: z.string().trim().min(1).optional(),
    force: z.boolean().optional(),
  })
  .strict();

export const uninstallPluginInputSchema = z
  .object({
    pluginId: idSchema,
    version: z.string().trim().min(1).optional(),
    force: z.boolean().optional(),
  })
  .strict();

export const setPluginEnablementInputSchema = z
  .object({
    workspaceSlug: idSchema.optional(),
    pluginId: idSchema,
    version: z.string().trim().min(1).optional(),
    force: z.boolean().optional(),
    scope: z.enum(["global", "workspace"]),
    enabled: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === "workspace" && !value.workspaceSlug) {
      ctx.addIssue({
        code: "custom",
        path: ["workspaceSlug"],
        message: "workspaceSlug is required for workspace scope",
      });
    }
  });

export const setPluginActiveVersionInputSchema = z
  .object({
    pluginId: idSchema,
    version: z.string().trim().min(1),
    acceptedPermissionsHash: z.string().trim().min(1).optional(),
    force: z.boolean().optional(),
  })
  .strict();

export const getPluginAuditLogInputSchema = z.object({
  pluginId: idSchema,
  workspaceSlug: idSchema.optional(),
  limit: z.number().int().positive().optional(),
});

export const verifySchema = z
  .object({
    method: z.enum(["tcp-port", "chrome-extension", "http-get", "none"]),
    detail: z.string().optional(),
  })
  .strict();

// 安全加固：防止 pluginId/version/artifactPath 含 ".." 逃逸 installedRoot
const bridgePluginIdSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-z0-9_.-]+$/i, "非法 pluginId")
  .refine((v) => !v.includes(".."), { message: "pluginId 不得含 .. 序列" });
const bridgeVersionSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-z0-9_.-]+$/i, "非法 version")
  .refine((v) => !v.includes(".."), { message: "version 不得含 .. 序列" });
export const checkBridgeStatusInputSchema = z
  .object({
    pluginId: bridgePluginIdSchema,
    version: bridgeVersionSchema,
    verify: verifySchema,
  })
  .strict();
