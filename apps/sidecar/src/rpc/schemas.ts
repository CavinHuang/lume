import { idSchema, optionalIdSchema, z } from "./validation";

export const agentSendInputSchema = z.object({
  threadId: z.string().min(1),
  userMessage: z.string(),
  modelRef: z.string().optional(),
  channelId: z.string().optional(),
  modelId: z.string().optional(),
  workspaceId: z.string().optional(),
  chatType: z.enum(["direct", "group", "channel"]).optional(),
  threadType: z.enum(["main", "subagent", "group", "channel"]).optional(),
  permissionMode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"]).optional(),
  thinkingLevel: z.enum(["off", "low", "medium", "high", "max"]).optional(),
  messageMetadata: z.record(z.string(), z.unknown()).optional(),
  resendFromMessageId: z.string().optional(),
  editFromMessageId: z.string().optional()
});

export const agentAppendInputSchema = agentSendInputSchema;

const memoryScopeSchema = z.enum(["global", "workspace", "agent", "session"]);
const memoryKindSchema = z.enum(["raw", "summary", "fact", "preference", "decision", "episode", "lesson", "milestone", "artifact"]);
const memorySourceSchema = z.enum(["memory", "sessions", "session", "file", "tool", "manual", "flush", "distillation", "promotion"]);
const memorySearchStrategySchema = z.enum(["hybrid", "keyword", "vector", "recent"]);

export const memorySearchInputSchema = z.object({
  workspaceSlug: idSchema,
  query: z.string().min(1),
  maxResults: z.number().int().min(1).max(50).optional(),
  minScore: z.number().min(0).max(1).optional(),
  scopes: z.array(memoryScopeSchema).optional(),
  kinds: z.array(memoryKindSchema).optional(),
  sources: z.array(memorySourceSchema).optional(),
  includeGlobal: z.boolean().optional(),
  includeRecent: z.boolean().optional(),
  includeLongTerm: z.boolean().optional(),
  includeWorkspaceBrief: z.boolean().optional(),
  includeSessions: z.boolean().optional(),
  strategy: memorySearchStrategySchema.optional()
});

export const memoryReadToolInputSchema = z.object({
  workspaceSlug: idSchema,
  id: z.string().optional(),
  path: z.string().optional(),
  from: z.number().int().min(1).optional(),
  lines: z.number().int().min(1).optional()
});

export const memoryRememberToolInputSchema = z.object({
  workspaceSlug: idSchema,
  scope: memoryScopeSchema,
  kind: memoryKindSchema,
  content: z.string().min(1),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  importance: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
  confidence: z.number().min(0).max(1).optional(),
  sourceSessionId: z.string().optional(),
  sourceMessageIds: z.array(z.string()).optional(),
  requireReview: z.boolean().optional()
});

export const memoryToolPolicySchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional()
});

export const updateMemoryRuntimeConfigInputSchema = z.object({
  tools: memoryToolPolicySchema.optional(),
  citations: z.enum(["on", "off", "auto"]).optional(),
  sources: z.array(z.enum(["memory", "sessions"])).optional(),
  extraPaths: z.array(z.string()).optional()
});

export const agentCreateThreadInputSchema = z.object({
  title: z.string().optional(),
  modelRef: z.string().optional(),
  channelId: z.string().optional(),
  modelId: z.string().optional(),
  workspaceId: z.string().optional(),
  parentThreadId: z.string().optional()
});

export const agentThreadIdInputSchema = z.object({
  threadId: idSchema
});

export const agentRecentThreadMessagesInputSchema = z.object({
  threadId: idSchema,
  limit: z.number().int().min(1).max(2000)
});

export const agentGetThreadMessageVersionsInputSchema = z.object({
  threadId: idSchema,
  versionGroupId: idSchema
});

export const agentUpdateThreadTitleInputSchema = z.object({
  threadId: idSchema,
  title: z.string().min(1)
});

export const agentUpdateThreadModelSelectionInputSchema = z.object({
  threadId: idSchema,
  modelRef: z.string().nullable().optional(),
  channelId: z.string().nullable().optional(),
  modelId: z.string().nullable().optional()
});

export const agentMoveThreadInputSchema = z.object({
  threadId: idSchema,
  workspaceId: idSchema
});

export const agentTruncateThreadInputSchema = z.object({
  threadId: idSchema,
  messageId: idSchema
});

export const agentListSubagentRunsInputSchema = z.object({
  ownerThreadId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  status: z.enum(["accepted", "running", "completed", "errored", "aborted", "timed_out", "canceled"]).optional(),
  limit: z.number().int().min(1).max(500).optional()
});

export const workspaceSlugInputSchema = z.object({
  workspaceSlug: idSchema
});

export const systemConfigUpdateInputSchema = z.object({
  path: z.string().min(1),
  value: z.unknown()
});

const nonEmptyTrimmedStringSchema = z.string().trim().min(1);

const lumeConfigAgentStrategySchema = z.object({
  defaultChannelId: nonEmptyTrimmedStringSchema.optional(),
  defaultModelRef: nonEmptyTrimmedStringSchema.optional(),
  fallbackModelRefs: z.array(nonEmptyTrimmedStringSchema).optional()
}).strict();

const lumeConfigSubagentStrategySchema = z.object({
  defaultModelRef: nonEmptyTrimmedStringSchema.optional()
}).strict();

const lumeConfigUpdateBaseSchema = z.object({
  source: z.enum(["user", "agent", "system"]),
  workspaceSlug: optionalIdSchema,
  summary: z.string().optional()
});

export const lumeConfigUpdateInputSchema = z.union([
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("models.agent"),
    value: lumeConfigAgentStrategySchema
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("models.subagent"),
    value: lumeConfigSubagentStrategySchema
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("models.agent.defaultChannelId"),
    value: nonEmptyTrimmedStringSchema
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("models.agent.defaultModelRef"),
    value: nonEmptyTrimmedStringSchema
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("models.agent.fallbackModelRefs"),
    value: z.array(nonEmptyTrimmedStringSchema)
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("models.subagent.defaultModelRef"),
    value: nonEmptyTrimmedStringSchema
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("agent.thinkingLevel"),
    value: z.enum(["off", "low", "medium", "high", "max"]).nullable()
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("agent.permissionMode"),
    value: z.enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"]).nullable()
  })
]);

export const workspacePathInputSchema = z.object({
  workspaceSlug: idSchema,
  path: z.string().optional()
});

export const workspaceRequiredPathInputSchema = z.object({
  workspaceSlug: idSchema,
  path: idSchema
});

export const workspaceRenameFileInputSchema = z.object({
  workspaceSlug: idSchema,
  path: idSchema,
  newName: z.string().min(1)
});

export const workspaceMoveFileInputSchema = z.object({
  workspaceSlug: idSchema,
  path: idSchema,
  targetDir: idSchema
});

export const workspaceCreateInputSchema = z.object({
  name: z.string().min(1)
});

export const workspaceUpdateInputSchema = z.object({
  id: idSchema,
  name: z.string().min(1)
});

export const workspaceDeleteInputSchema = z.object({
  id: idSchema
});

const mcpServerEntrySchema = z.object({
  type: z.enum(["stdio", "http", "sse"]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean()
});

export const workspaceMcpConfigInputSchema = z.object({
  workspaceSlug: idSchema,
  config: z.object({
    servers: z.record(z.string(), mcpServerEntrySchema)
  }).default({ servers: {} })
});

export const deleteSkillInputSchema = z.object({
  workspaceSlug: idSchema,
  skillSlug: idSchema
});

export const skillMarketCatalogInputSchema = z.object({
  workspaceSlug: idSchema,
  includeBlockedSources: z.boolean().optional()
});

export const skillMarketDetailInputSchema = z.object({
  workspaceSlug: idSchema,
  skillSlug: idSchema
});

export const githubSkillReviewInputSchema = z.object({
  url: z.string().url()
});

export const installGitHubSkillInputSchema = z.object({
  url: z.string().url(),
  workspaceSlug: idSchema,
  reviewToken: z.string().min(1),
  overwrite: z.boolean().optional()
});

export const importLocalSkillDirectoryInputSchema = z.object({
  workspaceSlug: idSchema,
  localPath: z.string().min(1),
  overwrite: z.boolean().optional()
});

export const installSkillMarketItemInputSchema = z.object({
  workspaceSlug: idSchema,
  skillId: z.string().min(1),
  overwrite: z.boolean().optional()
});

export const threadPathInputSchema = z.object({
  workspaceSlug: optionalIdSchema,
  threadId: idSchema
});

export const listDirectoryInputSchema = z.object({
  workspaceSlug: optionalIdSchema,
  threadId: idSchema,
  path: z.string().optional()
});

export const pathFileInputSchema = z.object({
  workspaceSlug: optionalIdSchema,
  threadId: idSchema,
  path: idSchema
});

export const renameFileInputSchema = z.object({
  workspaceSlug: optionalIdSchema,
  threadId: idSchema,
  path: idSchema,
  newName: z.string().min(1)
});

export const moveFileInputSchema = z.object({
  workspaceSlug: optionalIdSchema,
  threadId: idSchema,
  path: idSchema,
  targetDir: idSchema
});

export const attachedPathInputSchema = z.object({
  path: idSchema
});

export const renameAttachedFileInputSchema = z.object({
  path: idSchema,
  newName: z.string().min(1)
});

export const moveAttachedFileInputSchema = z.object({
  path: idSchema,
  targetDir: idSchema
});

export const promoteFileToWorkspaceInputSchema = z.object({
  workspaceSlug: idSchema,
  threadId: idSchema,
  filePath: idSchema,
  conflictMode: z.enum(["overwrite", "rename"]).optional()
});

export const searchWorkspaceFilesInputSchema = z.object({
  workspaceSlug: optionalIdSchema,
  threadId: idSchema,
  query: z.string().default(""),
  limit: z.number().int().min(1).max(200).optional(),
  rootPath: z.string().optional()
});

export const saveFilesToThreadInputSchema = z.object({
  workspaceSlug: optionalIdSchema,
  threadId: idSchema,
  files: z.array(z.object({
    filename: z.string().min(1),
    data: z.string().optional(),
    sourcePath: z.string().min(1).optional()
  }).refine((file) => !!file.data || !!file.sourcePath, {
    message: "文件必须提供 data 或 sourcePath"
  }))
});

export const saveFilesToWorkspaceInputSchema = z.object({
  workspaceSlug: idSchema,
  files: z.array(z.object({
    filename: z.string().min(1),
    data: z.string().optional(),
    sourcePath: z.string().min(1).optional()
  }).refine((file) => !!file.data || !!file.sourcePath, {
    message: "文件必须提供 data 或 sourcePath"
  }))
});

export const copyFolderToThreadInputSchema = z.object({
  sourcePath: idSchema,
  workspaceSlug: optionalIdSchema,
  threadId: idSchema
});

export const attachWorkspaceResourceToThreadInputSchema = z.object({
  workspaceSlug: idSchema,
  threadId: idSchema,
  sourcePath: idSchema
});

export const submitAskUserQuestionInputSchema = z.object({
  threadId: idSchema,
  toolUseId: idSchema,
  canceled: z.boolean().optional(),
  answers: z.record(z.string(), z.string()).optional()
});

export const submitToolPermissionInputSchema = z.object({
  threadId: idSchema,
  requestId: idSchema,
  decision: z.enum(["allow_once", "allow_always", "deny"])
});

export const submitTaskApprovalInputSchema = z.object({
  threadId: idSchema,
  contractId: idSchema,
  decision: z.enum(["approve", "reject"]),
  execute: z.boolean().optional(),
  feedback: z.string().optional()
});

export const executeTaskContractInputSchema = z.object({
  threadId: idSchema,
  contractId: idSchema.optional(),
  permissionMode: z.enum(["default", "acceptEdits", "bypassPermissions", "dontAsk"]).optional(),
  intent: z.enum(["execute", "continue", "retry", "skip"]).optional()
});

export const pendingInteractiveInputSchema = z.object({
  threadId: z.string().optional()
});

export const resumeRunInputSchema = z.object({
  threadId: idSchema,
  runId: idSchema.optional(),
  interruptionId: idSchema.optional()
});

export const listRunStatesInputSchema = z.object({
  threadId: idSchema
});

export const threadRunEventsInputSchema = z.object({
  threadId: idSchema
});

export const runTraceInputSchema = z.object({
  threadId: idSchema,
  runId: idSchema.optional(),
  traceId: idSchema.optional(),
  redactionLevel: z.enum(["safe_summary", "diagnostic"]).optional()
});

const bootstrapFileTypeSchema = z.enum([
  "SOUL",
  "USER",
  "IDENTITY",
  "AGENTS",
  "TOOLS",
  "HEARTBEAT",
  "MEMORY",
  "BOOTSTRAP"
]);

export const readBootstrapFileInputSchema = z.object({
  workspaceSlug: idSchema,
  fileType: bootstrapFileTypeSchema
});

export const writeBootstrapFileInputSchema = z.object({
  workspaceSlug: idSchema,
  fileType: bootstrapFileTypeSchema,
  content: z.string()
});

export const proxySettingsInputSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  mode: z.enum(["off", "system", "custom"]),
  httpProxy: z.string().optional(),
  httpsProxy: z.string().optional(),
  noProxy: z.string().optional()
});

const automationScheduleSchema = z.object({
  type: z.enum(["cron", "once", "interval", "manual"]),
  cronExpr: z.string().optional(),
  runAt: z.number().optional(),
  intervalMs: z.number().optional(),
  timezone: z.string().optional()
});

const automationSystemActionSchema = z.enum(["memory_distill_workspace"]);
const automationTriggerModeSchema = z.enum(["manual", "schedule", "webhook", "chat"]);

export const automationCreateInputSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  workspaceId: z.string().optional(),
  threadId: z.string().optional(),
  schedule: automationScheduleSchema,
  triggerModes: z.array(automationTriggerModeSchema).optional(),
  description: z.string().optional(),
  defaultModel: z.string().optional(),
  toolResourceIds: z.array(z.string()).optional(),
  prompt: z.string().min(1),
  systemAction: automationSystemActionSchema.optional()
});

export const automationUpdateInputSchema = z.object({
  id: idSchema,
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  workspaceId: z.string().optional(),
  threadId: z.string().optional(),
  schedule: automationScheduleSchema.optional(),
  triggerModes: z.array(automationTriggerModeSchema).optional(),
  description: z.string().optional(),
  defaultModel: z.string().optional(),
  toolResourceIds: z.array(z.string()).optional(),
  prompt: z.string().min(1).optional(),
  systemAction: automationSystemActionSchema.optional()
});

export const automationDeleteInputSchema = z.object({
  id: idSchema
});

export const automationListRunsInputSchema = z.object({
  jobId: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional()
});

export const automationRunNowInputSchema = z.object({
  id: idSchema
});

export const automationToggleInputSchema = z.object({
  id: idSchema
});

export const githubReleaseByTagInputSchema = z.object({
  tag: z.string().min(1)
});

export const updateUiStateInputSchema = z.object({
  activeView: z.enum(["conversations", "settings"]).optional(),
  currentAgentThreadId: z.string().nullable().optional(),
  currentAgentWorkspaceId: z.string().nullable().optional(),
  promptSidebarOpen: z.boolean().optional(),
  agentSidePanelOpenByThreadId: z.record(z.string(), z.boolean()).optional(),
  agentDraftByThreadId: z.record(z.string(), z.string()).optional()
});

export const updateGeneralSettingsInputSchema = z.object({
  themeMode: z.enum(["system", "light", "dark"]).optional(),
  userProfile: z.object({
    displayName: z.string().optional()
  }).optional(),
  windowBehavior: z.object({
    minimizeToTray: z.boolean().optional(),
    closeToTray: z.boolean().optional()
  }).optional(),
  updateSettings: z.object({
    autoCheckUpdates: z.boolean().optional(),
    notifyAfterDownload: z.boolean().optional(),
    installOnlyWhenIdle: z.boolean().optional(),
    lastUpdateCheckAt: z.string().nullable().optional()
  }).optional()
});

export const clearCacheInputSchema = z.object({
  logs: z.boolean().optional()
}).strict();

export const lumeConfigEffectiveInputSchema = z.object({
  workspaceSlug: optionalIdSchema
});
