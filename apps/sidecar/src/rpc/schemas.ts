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
  sessionId: z.string().min(1),
  userMessage: z.string(),
  channelId: z.string().optional(),
  modelId: z.string().optional(),
  workspaceId: z.string().optional(),
  chatType: z.enum(["direct", "group", "channel"]).optional(),
  sessionType: z.enum(["main", "subagent", "group", "channel"]).optional(),
  permissionMode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan"]).optional(),
  thinkingLevel: z.enum(["off", "low", "medium", "high", "max"]).optional(),
  messageMetadata: z.record(z.string(), z.unknown()).optional(),
  resendFromMessageId: z.string().optional(),
  editFromMessageId: z.string().optional()
});

export const memoryIndexWorkspaceInputSchema = z.object({
  workspaceSlug: idSchema,
  force: z.boolean().optional()
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

export const agentCreateSessionInputSchema = z.object({
  title: z.string().optional(),
  channelId: z.string().optional(),
  modelId: z.string().optional(),
  workspaceId: z.string().optional(),
  parentSessionId: z.string().optional()
});

export const agentSessionIdInputSchema = z.object({
  sessionId: idSchema
});

export const agentRecentMessagesInputSchema = z.object({
  sessionId: idSchema,
  limit: z.number().int().min(1).max(2000)
});

export const agentGetMessageVersionsInputSchema = z.object({
  sessionId: idSchema,
  versionGroupId: idSchema
});

export const agentUpdateTitleInputSchema = z.object({
  sessionId: idSchema,
  title: z.string().min(1)
});

export const agentUpdateModelSelectionInputSchema = z.object({
  sessionId: idSchema,
  channelId: z.string().optional(),
  modelId: z.string().optional()
});

export const agentMigrateChatInputSchema = z.object({
  conversationId: idSchema,
  sessionId: idSchema
});

export const agentMoveSessionInputSchema = z.object({
  sessionId: idSchema,
  workspaceId: idSchema
});

export const agentTruncateInputSchema = z.object({
  sessionId: idSchema,
  messageId: idSchema
});

export const agentListSubagentRunsInputSchema = z.object({
  ownerSessionId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  status: z.enum(["accepted", "running", "completed", "errored", "aborted", "timed_out", "canceled"]).optional(),
  limit: z.number().int().min(1).max(500).optional()
});

export const workspaceSlugInputSchema = z.object({
  workspaceSlug: idSchema
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

export const sessionPathInputSchema = z.object({
  workspaceSlug: idSchema,
  sessionId: idSchema
});

export const listDirectoryInputSchema = z.object({
  workspaceSlug: idSchema,
  sessionId: idSchema,
  path: z.string().optional()
});

export const pathFileInputSchema = z.object({
  workspaceSlug: idSchema,
  sessionId: idSchema,
  path: idSchema
});

export const renameFileInputSchema = z.object({
  workspaceSlug: idSchema,
  sessionId: idSchema,
  path: idSchema,
  newName: z.string().min(1)
});

export const moveFileInputSchema = z.object({
  workspaceSlug: idSchema,
  sessionId: idSchema,
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

export const searchWorkspaceFilesInputSchema = z.object({
  workspaceSlug: idSchema,
  sessionId: idSchema,
  query: z.string().default(""),
  limit: z.number().int().min(1).max(200).optional(),
  rootPath: z.string().optional()
});

export const plansReadDeleteInputSchema = z.object({
  workspaceSlug: optionalIdSchema,
  sessionId: idSchema,
  planPath: idSchema
});

export const plansListInputSchema = z.object({
  workspaceSlug: optionalIdSchema,
  sessionId: idSchema
});

export const saveFilesToSessionInputSchema = z.object({
  workspaceSlug: idSchema,
  sessionId: idSchema,
  files: z.array(z.object({
    filename: z.string().min(1),
    data: z.string()
  }))
});

export const copyFolderToSessionInputSchema = z.object({
  sourcePath: idSchema,
  workspaceSlug: idSchema,
  sessionId: idSchema
});

export const submitAskUserQuestionInputSchema = z.object({
  sessionId: idSchema,
  toolUseId: idSchema,
  canceled: z.boolean().optional(),
  answers: z.record(z.string(), z.string()).optional()
});

export const submitToolPermissionInputSchema = z.object({
  sessionId: idSchema,
  requestId: idSchema,
  decision: z.enum(["allow_once", "allow_always", "deny"])
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

export const automationCreateInputSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  workspaceId: z.string().optional(),
  sessionId: z.string().optional(),
  schedule: automationScheduleSchema,
  prompt: z.string().min(1)
});

export const automationUpdateInputSchema = z.object({
  id: idSchema,
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  workspaceId: z.string().optional(),
  sessionId: z.string().optional(),
  schedule: automationScheduleSchema.optional(),
  prompt: z.string().min(1).optional()
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

const channelProviderSchema = z.enum(["telegram", "discord", "whatsapp", "slack", "feishu"]);

const channelInboundEventSchema = z.object({
  id: idSchema,
  provider: channelProviderSchema,
  externalChatId: idSchema,
  externalUserId: z.string().optional(),
  externalMessageId: idSchema,
  text: z.string().min(1),
  receivedAt: z.number(),
  workspaceId: z.string().optional(),
  sessionId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const channelGatewayIngressInputSchema = z.object({
  event: channelInboundEventSchema
});

export const channelGatewayUpsertBindingInputSchema = z.object({
  provider: channelProviderSchema,
  externalChatId: idSchema,
  externalUserId: z.string().optional(),
  workspaceId: z.string().optional(),
  sessionId: idSchema
});

export const channelGatewayListDeliveriesInputSchema = z.object({
  provider: channelProviderSchema.optional(),
  limit: z.number().int().min(1).max(500).optional()
});

export const feishuGatewaySaveInputSchema = z.object({
  enabled: z.boolean(),
  connectionMode: z.enum(["websocket", "webhook"]).optional(),
  appId: z.string().default(""),
  appSecret: z.string().optional(),
  verificationToken: z.string().optional(),
  encryptKey: z.string().optional(),
  domain: z.enum(["feishu", "lark"]).optional(),
  defaultWorkspaceId: z.string().optional(),
  webhookPath: z.string().optional()
});

export const githubReleaseByTagInputSchema = z.object({
  tag: z.string().min(1)
});
