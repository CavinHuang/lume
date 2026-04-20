import { idSchema, optionalIdSchema, z } from "./validation";

export const fileAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mediaType: z.string(),
  localPath: z.string(),
  size: z.number()
});

export const chatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  createdAt: z.number(),
  model: z.string().optional(),
  reasoning: z.string().optional(),
  stopped: z.boolean().optional(),
  attachments: z.array(fileAttachmentSchema).optional(),
  toolActivities: z.array(z.object({
    toolCallId: z.string(),
    toolName: z.string(),
    type: z.enum(["start", "result"]),
    result: z.string().optional(),
    isError: z.boolean().optional()
  })).optional()
});

export const chatSendInputSchema = z.object({
  conversationId: z.string().min(1),
  userMessage: z.string(),
  messageHistory: z.array(chatMessageSchema),
  modelRef: z.string().optional(),
  channelId: z.string().min(1),
  modelId: z.string().min(1),
  systemMessage: z.string().optional(),
  contextLength: z.union([z.number(), z.literal("infinite")]).optional(),
  contextDividers: z.array(z.string()).optional(),
  attachments: z.array(fileAttachmentSchema).optional(),
  thinkingEnabled: z.boolean().optional(),
  thinkingLevel: z.enum(["off", "low", "medium", "high", "max"]).optional(),
  enabledToolIds: z.array(z.string()).optional()
});

export const chatConversationIdInputSchema = z.object({
  conversationId: idSchema
});

export const chatUpdateTitleInputSchema = z.object({
  conversationId: idSchema,
  title: z.string().min(1)
});

export const chatUpdateModelInputSchema = z.object({
  conversationId: idSchema,
  modelRef: z.string().optional(),
  modelId: z.string().optional(),
  channelId: z.string().optional()
});

export const chatMessageIdInputSchema = z.object({
  conversationId: idSchema,
  messageId: idSchema
});

export const chatTruncateInputSchema = z.object({
  conversationId: idSchema,
  messageId: idSchema,
  preserveFirstMessageAttachments: z.boolean().optional()
});

export const chatContextDividersInputSchema = z.object({
  conversationId: idSchema,
  dividers: z.array(z.string()).default([])
});

export const chatLocalPathInputSchema = z.object({
  localPath: idSchema
});

export const chatRecentMessagesInputSchema = z.object({
  conversationId: idSchema,
  limit: z.number().int().min(1)
});

export const attachmentSaveInputSchema = z.object({
  conversationId: z.string().min(1),
  filename: z.string().min(1),
  mediaType: z.string().min(1),
  data: z.string().optional(),
  sourcePath: z.string().min(1).optional()
}).refine((input) => !!input.data || !!input.sourcePath, {
  message: "附件必须提供 data 或 sourcePath"
});

export const systemPromptCreateInputSchema = z.object({
  name: z.string().min(1).max(50),
  content: z.string()
});

export const systemPromptUpdateInputSchema = z.object({
  id: idSchema,
  input: z.object({
    name: z.string().min(1).max(50).optional(),
    content: z.string().optional()
  })
});

export const systemPromptDeleteInputSchema = z.object({
  id: idSchema
});

export const systemPromptAppendInputSchema = z.object({
  enabled: z.boolean()
});

export const systemPromptSetDefaultInputSchema = z.object({
  id: z.string().min(1).nullable()
});

export const chatToolStateUpdateInputSchema = z.object({
  toolId: idSchema,
  state: z.object({
    enabled: z.boolean()
  })
});

export const chatToolCredentialsUpdateInputSchema = z.object({
  toolId: idSchema,
  credentials: z.record(z.string(), z.string())
});

export const chatToolIdInputSchema = z.object({
  toolId: idSchema
});

export const chatToolMetaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().optional(),
  category: z.enum(["builtin", "custom"]),
  params: z.array(z.object({
    name: z.string().min(1),
    type: z.enum(["string", "number", "boolean"]),
    description: z.string().min(1),
    required: z.boolean().optional(),
    enum: z.array(z.string()).optional()
  })).optional(),
  executorType: z.enum(["builtin", "http"]).optional(),
  httpConfig: z.object({
    urlTemplate: z.string().min(1),
    method: z.enum(["GET", "POST"]),
    headers: z.record(z.string(), z.string()).optional(),
    bodyTemplate: z.string().optional(),
    resultPath: z.string().optional()
  }).optional(),
  systemPromptAppend: z.string().optional()
});

export const chatToolCreateCustomInputSchema = z.object({
  meta: chatToolMetaSchema
});

export const agentSendInputSchema = z.object({
  threadId: z.string().min(1),
  userMessage: z.string(),
  modelRef: z.string().optional(),
  channelId: z.string().optional(),
  modelId: z.string().optional(),
  workspaceId: z.string().optional(),
  chatType: z.enum(["direct", "group", "channel"]).optional(),
  threadType: z.enum(["main", "subagent", "group", "channel"]).optional(),
  permissionMode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan"]).optional(),
  thinkingLevel: z.enum(["off", "low", "medium", "high", "max"]).optional(),
  messageMetadata: z.record(z.string(), z.unknown()).optional(),
  resendFromMessageId: z.string().optional(),
  editFromMessageId: z.string().optional()
});

export const agentAppendInputSchema = agentSendInputSchema;

export const memoryIndexWorkspaceInputSchema = z.object({
  workspaceSlug: idSchema,
  force: z.boolean().optional()
});

export const memoryDistillInputSchema = z.object({
  workspaceSlug: idSchema
});

export const memoryIndexFileInputSchema = z.object({
  workspaceSlug: idSchema,
  filePath: idSchema,
  force: z.boolean().optional()
});

export const memorySearchInputSchema = z.object({
  workspaceSlug: idSchema,
  query: z.string().min(1),
  maxResults: z.number().int().min(1).max(50).optional(),
  minScore: z.number().min(0).max(1).optional()
});

export const memoryGetInputSchema = z.object({
  workspaceSlug: idSchema,
  path: idSchema,
  from: z.number().int().min(1).optional(),
  lines: z.number().int().min(1).optional()
});

export const memorySaveInputSchema = z.object({
  workspaceSlug: idSchema,
  content: z.string().min(1),
  path: z.string().optional(),
  date: z.string().optional()
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

export const agentMigrateChatInputSchema = z.object({
  conversationId: idSchema,
  threadId: idSchema
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
    value: z.enum(["default", "acceptEdits", "bypassPermissions", "plan"]).nullable()
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

export const marketplaceDetailInputSchema = z.object({
  marketplaceId: idSchema
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

export const plansReadDeleteInputSchema = z.object({
  workspaceSlug: optionalIdSchema,
  threadId: idSchema,
  planPath: idSchema
});

export const plansListInputSchema = z.object({
  workspaceSlug: optionalIdSchema,
  threadId: idSchema
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

export const pendingInteractiveInputSchema = z.object({
  threadId: z.string().optional()
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

const toolPolicyRuleSchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional()
});

export const saveToolPolicyInputSchema = z.object({
  version: z.number().optional(),
  tools: z.object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    byProvider: z.record(z.string(), toolPolicyRuleSchema).optional(),
    bySessionType: z.record(z.string(), toolPolicyRuleSchema).optional(),
    byChatType: z.record(z.string(), toolPolicyRuleSchema).optional(),
    subagent: toolPolicyRuleSchema.optional()
  }).optional()
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
  type: z.enum(["cron", "once", "interval"]),
  cronExpr: z.string().optional(),
  runAt: z.number().optional(),
  intervalMs: z.number().optional(),
  timezone: z.string().optional()
});

const automationSystemActionSchema = z.enum(["memory_distill_workspace"]);

export const automationCreateInputSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  workspaceId: z.string().optional(),
  threadId: z.string().optional(),
  schedule: automationScheduleSchema,
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

export const githubReleaseByTagInputSchema = z.object({
  tag: z.string().min(1)
});

export const updateUiStateInputSchema = z.object({
  appMode: z.enum(["chat", "agent"]).optional(),
  activeView: z.enum(["conversations", "settings"]).optional(),
  currentConversationId: z.string().nullable().optional(),
  currentAgentThreadId: z.string().nullable().optional(),
  currentAgentWorkspaceId: z.string().nullable().optional(),
  promptSidebarOpen: z.boolean().optional(),
  agentSidePanelOpenByThreadId: z.record(z.string(), z.boolean()).optional(),
  chatDraftByConversationId: z.record(z.string(), z.string()).optional(),
  agentDraftByThreadId: z.record(z.string(), z.string()).optional()
});

export const updateGeneralSettingsInputSchema = z.object({
  themeMode: z.enum(["system", "light", "dark"]).optional(),
  windowBehavior: z.object({
    minimizeToTray: z.boolean().optional(),
    closeToTray: z.boolean().optional()
  }).optional()
});

export const clearCacheInputSchema = z.object({
  logs: z.boolean().optional()
}).strict();

export const lumeConfigEffectiveInputSchema = z.object({
  workspaceSlug: optionalIdSchema
});
