import { normalizeMcpTransport, type InspectMarketSourceRef, type PluginSourceRef, type SkillMarketSourceRef } from "@lume/shared";
import { idSchema, optionalIdSchema, z } from "./validation";

const relativeThreadPathSchema = z.string()
  .min(1)
  .refine((value) => (
    !value.startsWith("/")
    && !/^[a-zA-Z]:[\\/]/.test(value)
    && !value.split(/[\\/]/).includes("..")
  ), {
    message: "附件路径必须是线程内相对路径"
  });

const rendererFileRefSchema = z.object({
  source: z.enum(["project", "session", "memory", "legacy"]),
  scopeId: z.string().trim().min(1),
  relativePath: z.string()
}).strict();

const agentMessageAttachmentInputSchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
  mediaType: z.string().min(1),
  size: z.number().int().min(0),
  threadPath: relativeThreadPathSchema,
  fileRef: rendererFileRefSchema.optional()
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
  permissionMode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"]).optional(),
  thinkingLevel: z.enum(["off", "low", "medium", "high", "max"]).optional(),
  messageAttachments: z.array(agentMessageAttachmentInputSchema).optional(),
  messageMetadata: z.record(z.string(), z.unknown()).optional(),
  resendFromMessageId: z.string().optional(),
  editFromMessageId: z.string().optional(),
  traceContext: z.object({
    submissionId: z.string().uuid(),
    clientEventId: z.string().uuid().optional(),
    traceId: z.string().uuid().optional(),
    origin: z.union([
      z.enum(["main_window", "quick_input", "automation", "routine", "subagent", "resume", "task", "internal"]),
      z.string().regex(/^im\.[a-z0-9_-]{1,64}$/)
    ]).optional(),
    parentTraceId: z.string().uuid().optional(),
    parentSpanId: z.string().uuid().optional(),
    linkedTraceId: z.string().uuid().optional()
  }).strict().optional()
});

export const agentAppendInputSchema = agentSendInputSchema;

export const imAccountCreateInputSchema = z.object({
  provider: z.literal("weixin"),
  accountKey: z.string().optional(),
  label: z.string().optional(),
  token: z.string().trim().min(1),
  uin: z.string().optional(),
  workspaceId: z.string().optional(),
  baseUrl: z.string().optional(),
  enabled: z.boolean().optional()
});

export const imAccountUpdateInputSchema = z.object({
  id: idSchema,
  input: z.object({
    accountKey: z.string().optional(),
    label: z.string().optional(),
    token: z.string().optional(),
    uin: z.string().optional(),
    workspaceId: z.string().optional(),
    baseUrl: z.string().optional(),
    enabled: z.boolean().optional(),
    status: z.enum(["stopped", "starting", "running", "error", "auth_required"]).optional(),
    cursor: z.string().optional(),
    contextToken: z.string().optional(),
    lastError: z.string().nullable().optional(),
    lastStartedAt: z.number().optional(),
    lastStoppedAt: z.number().optional()
  }).strict()
});

export const imAccountIdInputSchema = z.object({
  id: idSchema
});

export const imWeixinLoginStartInputSchema = z.object({
  force: z.boolean().optional(),
  workspaceId: z.string().optional()
}).optional();

export const imWeixinLoginPollInputSchema = z.object({
  sessionKey: idSchema,
  verifyCode: z.string().optional()
});

const readingSourceKindSchema = z.enum(["weread", "gutenberg", "poetry", "manual", "generated"]);
const readingBookTrackSchema = z.enum(["lume", "co_read", "recommended"]);
const readingBookStatusSchema = z.enum(["queued", "reading", "finished", "paused"]);
const readingNoteDepthSchema = z.enum(["seed", "deep"]);

const readingSourceRefSchema = z.object({
  kind: readingSourceKindSchema.optional(),
  externalId: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  author: z.string().optional(),
  location: z.string().optional(),
  excerpt: z.string().optional()
}).strict();

const readingQuoteEvidenceSchema = z.object({
  quote: z.string().min(1),
  sourceKind: readingSourceKindSchema,
  sourceId: z.string().optional(),
  sourceTitle: z.string().optional(),
  location: z.string().optional(),
  excerpt: z.string().optional(),
  url: z.string().optional(),
  capturedAt: z.number()
}).strict();

export const readingUpdateSettingsInputSchema = z.object({
  cadence: z.enum(["off", "weekly", "few_times_weekly", "manual"]).optional(),
  quiet: z.boolean().optional(),
  maxDeepNotesPerWeek: z.number().int().min(1).max(4).optional(),
  textModelMode: z.enum(["inherit", "explicit"]).optional(),
  textModelRef: z.string().nullable().optional(),
  imageModelRef: z.string().nullable().optional(),
  advanced: z.object({
    selectionModelRef: z.string().optional(),
    seedModelRef: z.string().optional(),
    deepModelRef: z.string().optional(),
    companionModelRef: z.string().optional()
  }).strict().optional()
}).strict();

export const readingListNotesInputSchema = z.object({
  bookId: z.string().optional(),
  includeHidden: z.boolean().optional(),
  includeDeleted: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional()
}).strict().optional();

export const readingAddBookInputSchema = z.object({
  title: z.string().min(1),
  author: z.string().optional(),
  track: readingBookTrackSchema.optional(),
  status: readingBookStatusSchema.optional(),
  source: readingSourceRefSchema.optional(),
  coverUrl: z.string().optional(),
  progressPercent: z.number().min(0).max(100).optional(),
  tags: z.array(z.string()).optional()
}).strict();

export const readingAddBookToAliceInputSchema = z.object({
  title: z.string().trim().min(1),
  reason: z.string().trim().optional()
}).strict();

export const readingUpdateBookInputSchema = z.object({
  id: idSchema,
  input: z.object({
    title: z.string().min(1).optional(),
    author: z.string().optional(),
    track: readingBookTrackSchema.optional(),
    status: readingBookStatusSchema.optional(),
    source: readingSourceRefSchema.optional(),
    coverUrl: z.string().optional(),
    progressPercent: z.number().min(0).max(100).optional(),
    tags: z.array(z.string()).optional()
  }).strict()
}).strict();

export const readingNoteIdInputSchema = z.object({
  id: idSchema
}).strict();

export const readingMarkSeenInputSchema = z.object({
  noteIds: z.array(z.string().min(1)).optional()
}).strict().optional();

const readingUserContextSchema = z.object({
  userHighlights: z.array(z.object({
    quote: z.string().min(1),
    note: z.string().optional(),
    sourceId: z.string().optional(),
    chapterTitle: z.string().optional()
  }).strict()).optional(),
  userThoughts: z.array(z.string()).optional(),
  memorySnippets: z.array(z.string()).optional(),
  recentConversationSnippets: z.array(z.string()).optional(),
  recentReadingNoteSnippets: z.array(z.string()).optional(),
  recentConversationSummary: z.string().optional(),
  recentDiarySummary: z.string().optional()
}).strict();

export const readingRunTaskInputSchema = z.object({
  trigger: z.enum(["manual", "scheduled", "progress", "conversation"]).optional(),
  bookId: z.string().optional(),
  depth: readingNoteDepthSchema.optional(),
  workspaceSlug: z.string().trim().optional(),
  userContext: readingUserContextSchema.optional(),
  manualQuoteText: z.string().optional(),
  manualSource: z.string().optional()
}).strict().optional();

export const readingReviseNoteInputSchema = z.object({
  id: idSchema,
  body: z.string().min(1),
  summary: z.string().optional(),
  editReason: z.string().min(1),
  modelRef: z.string().optional()
}).strict();

export const readingBookIdInputSchema = z.object({
  bookId: z.string().min(1)
}).strict();

export const readingConnectWereadInputSchema = z.object({
  apiKey: z.string().trim().min(1),
  accountName: z.string().optional()
}).strict();

export const readingSearchWereadInputSchema = z.object({
  query: z.string().trim().min(1),
  limit: z.number().int().min(1).max(20).optional()
}).strict();

export const readingSearchBooksInputSchema = z.object({
  query: z.string().trim().min(1),
  limit: z.number().int().min(1).max(20).optional()
}).strict();

export const wereadApiKeyInputSchema = z.object({
  apiKey: z.string().trim().min(1)
}).strict();

export const wereadBookIdInputSchema = z.object({
  bookId: z.string().trim().min(1)
}).strict();

export const wereadReadDataInputSchema = z.object({
  period: z.string().trim().optional()
}).strict().optional();

export const wereadBestBookmarksInputSchema = z.object({
  bookId: z.string().trim().min(1),
  bookTitle: z.string().trim().optional()
}).strict();

export const wereadPublicReviewsInputSchema = z.object({
  bookId: z.string().trim().min(1),
  listType: z.string().trim().optional(),
  bookTitle: z.string().trim().optional()
}).strict();

export const wereadGenerateNoteInputSchema = z.object({
  bookTitle: z.string().trim().min(1),
  text: z.string().trim().min(1),
  source: z.string().trim().optional(),
  authorName: z.string().trim().optional(),
  bookId: z.string().trim().optional()
}).strict();

export const wereadSearchBooksInputSchema = z.object({
  keyword: z.string().trim().min(1),
  limit: z.number().int().min(1).max(20).optional()
}).strict();

export const readingGenerateShareCardInputSchema = z.object({
  noteId: idSchema,
  theme: z.enum(["light", "dark"]).optional(),
  outputPath: z.string().trim().min(1).optional()
}).strict();

export const aliceReadingNoteIdInputSchema = z.union([
  z.string().min(1),
  z.object({ id: z.string().min(1) }).strict(),
  z.object({ noteId: z.string().min(1) }).strict()
]);

export const aliceReadingNoteIdsInputSchema = z.union([
  z.array(z.string().min(1)),
  z.object({
    noteIds: z.array(z.string().min(1)).optional()
  }).strict()
]).optional();

export const aliceReadingListNotesInputSchema = z.object({
  bookId: z.string().min(1).optional(),
  interestId: z.string().min(1).optional(),
  wereadBookId: z.string().min(1).optional(),
  includeHidden: z.boolean().optional(),
  includeDeleted: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional()
}).strict().optional();

export const aliceReadingRunTaskInputSchema = z.object({
  trigger: z.enum(["manual", "scheduled", "progress", "conversation"]).optional(),
  bookId: z.string().optional(),
  interestId: z.string().min(1).optional(),
  wereadBookId: z.string().min(1).optional(),
  depth: readingNoteDepthSchema.optional(),
  workspaceSlug: z.string().trim().optional(),
  userContext: readingUserContextSchema.optional(),
  manualQuoteText: z.string().optional(),
  manualSource: z.string().optional()
}).strict().optional();

export const aliceReadingBookInputSchema = z.object({
  interestId: z.string().min(1).optional(),
  bookId: z.string().min(1).optional(),
  wereadBookId: z.string().min(1).optional()
}).strict().optional();

const memoryScopeSchema = z.enum(["global", "workspace"]);
const memoryKindSchema = z.enum(["raw", "summary", "fact", "preference", "decision", "episode", "lesson", "milestone", "artifact"]);
const memorySourceSchema = z.enum(["memory", "sessions", "session", "file", "tool", "manual"]);

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
  includeSessions: z.boolean().optional()
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

export const memoryOrganizeHistoryInputSchema = z.object({
  workspaceSlug: idSchema,
  limit: z.number().int().min(1).max(1000).optional()
});

export const memoryOrganizeEntriesInputSchema = z.object({
  workspaceSlug: idSchema
});

const memoryIngestTargetScopeSchema = z.enum(["global", "workspace"]);

export const memoryIngestSourcesInputSchema = z.object({
  workspaceSlug: idSchema,
  batchMaxChars: z.number().int().min(500).max(50000).optional(),
  sources: z.array(z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("pasted_text"),
      title: z.string().trim().min(1).optional(),
      content: z.string().min(1),
      targetScope: memoryIngestTargetScopeSchema.optional()
    }).strict(),
    z.object({
      kind: z.literal("workspace_file"),
      path: z.string().trim().min(1),
      targetScope: memoryIngestTargetScopeSchema.optional()
    }).strict(),
    z.object({
      kind: z.literal("local_file"),
      path: z.string().trim().min(1),
      targetScope: memoryIngestTargetScopeSchema.optional()
    }).strict(),
    z.object({
      kind: z.literal("local_folder"),
      path: z.string().trim().min(1),
      targetScope: memoryIngestTargetScopeSchema.optional()
    }).strict()
  ])).min(1).max(20)
});

export const memoryIngestSourcesJobInputSchema = z.object({
  jobId: z.string().trim().min(1)
});

export const memoryOrganizeJobInputSchema = memoryIngestSourcesJobInputSchema;

export const memoryOpenSourceInputSchema = z.object({
  workspaceSlug: idSchema,
  path: z.string().min(1)
});

export const memoryListSourceFilesInputSchema = z.object({
  workspaceSlug: idSchema,
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional()
}).strict();

const memoryEntryScopeSchema = z.enum(["global", "workspace"]);
const memoryEntryConfidenceSchema = z.enum(["low", "medium", "high"]);

export const memoryUpdateEntryInputSchema = z.object({
  workspaceSlug: idSchema,
  scope: memoryEntryScopeSchema,
  id: z.string().trim().min(1),
  statement: z.string().trim().min(1).optional(),
  kind: memoryKindSchema.optional(),
  confidence: memoryEntryConfidenceSchema.optional(),
  tags: z.array(z.string()).optional()
}).strict();

export const memoryDeleteEntryInputSchema = z.object({
  workspaceSlug: idSchema,
  scope: memoryEntryScopeSchema,
  id: z.string().trim().min(1)
}).strict();

export const memoryResolvePendingInputSchema = z.object({
  workspaceSlug: idSchema,
  path: z.string().trim().min(1),
  action: z.enum(["accept", "reject", "resolve"]),
  candidateOverride: z.object({
    statement: z.string().trim().min(1).optional(),
    kind: memoryKindSchema.optional(),
    confidence: memoryEntryConfidenceSchema.optional(),
    tags: z.array(z.string()).optional()
  }).strict().optional()
}).strict();

export const memoryToolPolicySchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional()
});

const memoryRetrievalConfigSchema = z.object({
  semantic: z.enum(["auto", "off"]).optional(),
  rerankModelRef: z.string().trim().min(1).optional()
}).strict();

export const updateMemoryRuntimeConfigInputSchema = z.object({
  tools: memoryToolPolicySchema.optional(),
  citations: z.enum(["on", "off", "auto"]).optional(),
  sources: z.array(z.enum(["memory", "sessions"])).optional(),
  extraPaths: z.array(z.string()).optional(),
  retrieval: memoryRetrievalConfigSchema.optional()
});

export const agentCreateThreadInputSchema = z.object({
  title: z.string().optional(),
  modelRef: z.string().optional(),
  channelId: z.string().optional(),
  modelId: z.string().optional(),
  workspaceId: z.string().optional(),
  parentThreadId: z.string().optional(),
  fileContextMode: z.enum(["newRoot", "inherit", "fork"]).optional()
}).superRefine((input, ctx) => {
  if (input.parentThreadId && input.fileContextMode !== "inherit") {
    ctx.addIssue({ code: "custom", path: ["fileContextMode"], message: "带 parentThreadId 的子 Agent 必须显式使用 inherit" });
  }
  if (!input.parentThreadId && input.fileContextMode === "inherit") {
    ctx.addIssue({ code: "custom", path: ["fileContextMode"], message: "inherit 需要 parentThreadId" });
  }
});

export const agentThreadIdInputSchema = z.object({
  threadId: idSchema
});

export const agentReorderMessageQueueInputSchema = z.object({
  threadId: idSchema,
  orderedMessageIds: z.array(idSchema)
});

export const agentQueuedMessageInputSchema = z.object({
  threadId: idSchema,
  queuedMessageId: idSchema
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

export const agentListSubagentWorkInputSchema = z.object({
  parentThreadId: idSchema
});

export const agentFinishSubagentTaskInputSchema = z.object({
  taskId: idSchema,
  resolution: z.enum(["accepted", "deferred", "cancelled"]),
  reason: z.string().min(1).max(4_000)
});

export const agentRetireSubagentInputSchema = z.object({
  subagentId: idSchema,
  reason: z.string().min(1).max(4_000)
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

const lumeConfigRoutineStrategySchema = z.object({
  defaultModelRef: nonEmptyTrimmedStringSchema.optional()
}).strict();

const lumeConfigSimpleModelStrategySchema = z.object({
  defaultModelRef: nonEmptyTrimmedStringSchema.optional()
}).strict();

const lumeConfigImageGenerationStrategySchema = z.object({
  priorityModelRefs: z.array(nonEmptyTrimmedStringSchema).optional()
}).strict();

const lumeConfigContextWindowsSchema = z.record(nonEmptyTrimmedStringSchema, z.number().int().positive());

const lumeConfigPermissionRuleSchema = z.object({
  id: z.string().optional(),
  tool: nonEmptyTrimmedStringSchema,
  commandPattern: z.string().optional(),
  pathPattern: z.string().optional(),
  action: z.enum(["allow", "ask", "deny"]),
  scope: z.enum(["session", "workspace", "global"]).optional()
}).strict();

const lumeConfigApprovalAllowAlwaysSchema = z.enum(["disabled", "desktop-only", "dm-only"]);

const lumeConfigSubagentApprovalSchema = z.object({
  mode: z.enum(["inherit", "ask-parent", "deny-high-risk"]).optional(),
  allowAlways: z.enum(["disabled", "desktop-only", "parent-only"]).optional()
}).strict();

const lumeConfigImAccountApprovalSchema = z.object({
  enabled: z.boolean().optional(),
  allowTextApprove: z.boolean().optional(),
  allowAlways: lumeConfigApprovalAllowAlwaysSchema.optional(),
  groupApproval: z.enum(["disabled", "desktop-only"]).optional(),
  approverPeerIds: z.array(nonEmptyTrimmedStringSchema).optional()
}).strict();

const lumeConfigImApprovalSchema = z.object({
  enabled: z.boolean().optional(),
  allowTextApprove: z.boolean().optional(),
  allowAlways: lumeConfigApprovalAllowAlwaysSchema.optional(),
  groupApproval: z.enum(["disabled", "desktop-only"]).optional(),
  accounts: z.record(z.string(), lumeConfigImAccountApprovalSchema).optional()
}).strict();

const lumeConfigPermissionApprovalsSchema = z.object({
  desktop: z.object({
    enabled: z.boolean().optional()
  }).strict().optional(),
  subagent: lumeConfigSubagentApprovalSchema.optional(),
  im: lumeConfigImApprovalSchema.optional()
}).strict();

const lumeConfigPermissionsSchema = z.object({
  toolPolicy: z.object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional()
  }).strict().optional(),
  rules: z.array(lumeConfigPermissionRuleSchema).optional(),
  classifier: z.object({
    enabled: z.boolean().optional()
  }).strict().optional(),
  privateWriteRoots: z.array(z.string()).optional(),
  approvals: lumeConfigPermissionApprovalsSchema.optional()
}).strict();

const lumeConfigWebSearchProviderSchema = z.object({
  enabled: z.boolean().optional(),
  apiKey: z.string().trim().min(1).optional()
}).strict();

const lumeConfigWebSearchSchema = z.object({
  strategy: z.enum(["priority", "joint"]).optional(),
  providers: z.object({
    guanlan: lumeConfigWebSearchProviderSchema.optional(),
    exa: lumeConfigWebSearchProviderSchema.optional(),
    pipellm: lumeConfigWebSearchProviderSchema.optional(),
    zhipu: lumeConfigWebSearchProviderSchema.optional(),
    tavily: lumeConfigWebSearchProviderSchema.optional(),
    brave: lumeConfigWebSearchProviderSchema.optional(),
    duckduckgo: lumeConfigWebSearchProviderSchema.optional(),
    bing: lumeConfigWebSearchProviderSchema.optional()
  }).strict().optional()
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
    path: z.literal("models.routine"),
    value: lumeConfigRoutineStrategySchema
  }),
  ...[
    "models.background",
    "models.contextCompression",
    "models.title",
    "models.welcomeSuggestions",
    "models.permissionClassifier",
    "models.memoryJudgement"
  ].map((path) => lumeConfigUpdateBaseSchema.extend({
    path: z.literal(path),
    value: lumeConfigSimpleModelStrategySchema
  })),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("models.imageGeneration"),
    value: lumeConfigImageGenerationStrategySchema
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("models.contextWindows"),
    value: lumeConfigContextWindowsSchema
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
    path: z.literal("models.routine.defaultModelRef"),
    value: nonEmptyTrimmedStringSchema
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("models.embedding.defaultModelRef"),
    value: nonEmptyTrimmedStringSchema
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("memory.extraction.modelRef"),
    value: z.string().nullable()
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("agent.thinkingLevel"),
    value: z.enum(["off", "low", "medium", "high", "max"]).nullable()
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("agent.permissionMode"),
    value: z.enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"]).nullable()
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("permissions"),
    value: lumeConfigPermissionsSchema
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("permissions.approvals"),
    value: lumeConfigPermissionApprovalsSchema
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("webSearch"),
    value: lumeConfigWebSearchSchema
  })
]);

export const workspacePathInputSchema = z.object({
  workspaceSlug: idSchema,
  path: z.string().optional()
});

export const legacyResourceExportInputSchema = z.object({
  workspaceSlug: idSchema,
  path: idSchema,
  conflict: z.literal("error")
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
  projectPath: z.string().trim().min(1),
  name: z.string().min(1).optional()
});

export const workspaceUpdateInputSchema = z.object({
  id: idSchema,
  name: z.string().min(1)
});

export const workspaceIdInputSchema = z.object({
  id: idSchema
});

export const workspaceDirectoryInputSchema = z.object({
  id: idSchema,
  projectPath: z.string().trim().min(1)
});

export const workspaceDeleteInputSchema = z.object({
  id: idSchema,
  mode: z.enum(["keepHistory", "deleteLumeData"])
});

const mcpServerEntrySchema = z.object({
  transport: z.enum(["stdio", "streamable_http", "sse"]).optional(),
  type: z.enum(["stdio", "http", "sse", "streamable_http"]).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  disabledTools: z.array(z.string()).optional(),
  enabled: z.boolean()
}).superRefine((entry, ctx) => {
  const transport = normalizeMcpTransport(entry);
  if (!transport) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["transport"],
      message: "MCP server requires transport or legacy type"
    });
    return;
  }

  if (transport === "stdio" && !entry.command?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["command"],
      message: "stdio MCP server requires command"
    });
  }

  if ((transport === "streamable_http" || transport === "sse") && !entry.url?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["url"],
      message: "remote MCP server requires url"
    });
  }
});

export const workspaceMcpConfigInputSchema = z.object({
  workspaceSlug: idSchema,
  config: z.object({
    servers: z.record(z.string(), mcpServerEntrySchema)
  }).default({ servers: {} })
});

export const mcpStatusInputSchema = z.object({
  workspaceSlug: idSchema,
  waitForConnections: z.boolean().optional()
});

export const mcpTestServerInputSchema = z.object({
  workspaceSlug: idSchema,
  serverId: idSchema
});

export const mcpListResourcesInputSchema = z.object({
  workspaceSlug: idSchema,
  serverId: idSchema.optional()
});

export const mcpReadResourceInputSchema = z.object({
  workspaceSlug: idSchema,
  serverId: idSchema,
  uri: z.string().min(1)
});

export const mcpCallToolDiagnosticInputSchema = z.object({
  workspaceSlug: idSchema,
  serverId: idSchema,
  originalToolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  timeoutMs: z.number().int().positive().optional()
});

const skillStorageScopeSchema = z.enum(["workspace", "project", "user"]);

export const deleteSkillInputSchema = z.object({
  workspaceSlug: idSchema,
  skillSlug: idSchema,
  storageScope: skillStorageScopeSchema.optional(),
  cwd: z.string().optional()
});

export const listEditableSkillsInputSchema = z.object({
  workspaceSlug: idSchema,
  cwd: z.string().optional()
}).strict();

export const editableSkillInputSchema = z.object({
  workspaceSlug: idSchema,
  skillSlug: idSchema,
  storageScope: skillStorageScopeSchema,
  cwd: z.string().optional()
}).strict();

export const saveSkillInputSchema = z.object({
  workspaceSlug: idSchema,
  storageScope: skillStorageScopeSchema.optional(),
  cwd: z.string().optional(),
  skillSlug: z.string().trim().min(1),
  name: z.string(),
  description: z.string().optional(),
  whenToUse: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  argumentHint: z.string().optional(),
  disableModelInvocation: z.boolean().optional(),
  version: z.string().optional(),
  prompt: z.string()
}).strict();

export const skillMarketCatalogInputSchema = z.object({
  workspaceSlug: idSchema,
  includeBlockedSources: z.boolean().optional()
});

export const skillMarketDetailInputSchema = z.object({
  workspaceSlug: idSchema,
  skillSlug: idSchema
});

export const skillVersionInputSchema = z.object({
  workspaceSlug: idSchema,
  skillSlug: idSchema,
  storageScope: skillStorageScopeSchema.optional(),
  cwd: z.string().optional(),
  filename: z.string().min(1).optional()
});

export const skillImprovementAnalysisInputSchema = z.object({
  workspaceSlug: idSchema,
  skillSlug: idSchema,
  storageScope: skillStorageScopeSchema.optional(),
  cwd: z.string().optional(),
  modelRef: z.string().trim().min(1).optional(),
  maxSessions: z.number().int().min(1).max(20).optional(),
  messagesPerSession: z.number().int().min(1).max(500).optional()
});

const skillImprovementUpdateSchema = z.object({
  section: z.string().min(1),
  change: z.string().min(1),
  reason: z.string().min(1)
}).strict();

export const applySkillImprovementInputSchema = z.object({
  workspaceSlug: idSchema,
  skillSlug: idSchema,
  storageScope: skillStorageScopeSchema.optional(),
  cwd: z.string().optional(),
  updates: z.array(skillImprovementUpdateSchema),
  modelRef: z.string().trim().min(1).optional()
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

const pluginSourceRefSchema: z.ZodType<PluginSourceRef> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("local"),
      path: z.string().trim().min(1)
    }).strict(),
    z.object({
      type: z.literal("github"),
      owner: idSchema,
      repo: idSchema,
      ref: z.string().trim().min(1),
      url: z.string().url(),
      subdir: z.string().trim().min(1).optional()
    }).strict(),
    z.object({
      type: z.literal("subscribed-market"),
      sourceId: idSchema,
      itemId: z.string().trim().min(1),
      resolved: pluginSourceRefSchema
    }).strict(),
    z.object({
      type: z.literal("legacy"),
      path: z.string().trim().min(1)
    }).strict()
  ])
);

const skillMarketSourceRefSchema: z.ZodType<SkillMarketSourceRef> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("skill-local"),
    path: z.string().trim().min(1)
  }).strict(),
  z.object({
    type: z.literal("skill-github"),
    url: z.string().url()
  }).strict()
]);

const inspectMarketSourceRefSchema: z.ZodType<InspectMarketSourceRef> = z.union([
  pluginSourceRefSchema,
  skillMarketSourceRefSchema,
  z.object({
    type: z.literal("market-item"),
    sourceId: idSchema,
    itemId: z.string().trim().min(1)
  }).strict()
]);

export const marketCatalogInputSchema = z.object({
  workspaceSlug: idSchema,
  includeBlockedSources: z.boolean().optional()
}).strict();

export const marketDetailInputSchema = z.object({
  workspaceSlug: idSchema,
  kind: z.enum(["plugin", "skill"]),
  itemId: z.string().trim().min(1)
}).strict();

export const inspectMarketSourceInputSchema = z.object({
  workspaceSlug: idSchema,
  source: inspectMarketSourceRefSchema
}).strict();

export const installMarketItemInputSchema = z.object({
  workspaceSlug: idSchema,
  kind: z.enum(["plugin", "skill"]),
  itemId: z.string().trim().min(1).optional(),
  source: inspectMarketSourceRefSchema.optional(),
  overwrite: z.boolean().optional(),
  enableScope: z.enum(["none", "workspace", "global"]).optional(),
  acceptedPermissionsHash: z.string().trim().min(1).optional()
}).strict();

export const updatePluginInputSchema = z.object({
  workspaceSlug: idSchema,
  pluginId: idSchema,
  source: pluginSourceRefSchema.optional(),
  targetVersion: z.string().trim().min(1).optional(),
  acceptedPermissionsHash: z.string().trim().min(1).optional(),
  force: z.boolean().optional()
}).strict();

export const uninstallPluginInputSchema = z.object({
  pluginId: idSchema,
  version: z.string().trim().min(1).optional(),
  force: z.boolean().optional()
}).strict();

export const setPluginEnablementInputSchema = z.object({
  workspaceSlug: idSchema.optional(),
  pluginId: idSchema,
  version: z.string().trim().min(1).optional(),
  force: z.boolean().optional(),
  scope: z.enum(["global", "workspace"]),
  enabled: z.boolean()
}).strict().superRefine((value, ctx) => {
  if (value.scope === "workspace" && !value.workspaceSlug) {
    ctx.addIssue({
      code: "custom",
      path: ["workspaceSlug"],
      message: "workspaceSlug is required for workspace scope"
    });
  }
});

export const setPluginActiveVersionInputSchema = z.object({
  pluginId: idSchema,
  version: z.string().trim().min(1),
  acceptedPermissionsHash: z.string().trim().min(1).optional(),
  force: z.boolean().optional()
}).strict();

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

export const fileRefSchema = rendererFileRefSchema;

export const fileRefInputSchema = z.object({ ref: fileRefSchema }).strict();
export const fileRefSearchInputSchema = z.object({
  ref: fileRefSchema,
  query: z.string().default(""),
  includeExcluded: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional()
}).strict();
export const fileRefRenameInputSchema = z.object({ ref: fileRefSchema, newName: z.string().min(1) }).strict();
export const fileRefMoveInputSchema = z.object({ ref: fileRefSchema, targetDirectory: fileRefSchema }).strict();
export const legacyFileRefConversionInputSchema = z.discriminatedUnion("recordKind", [
  z.object({ recordKind: z.literal("thread-attachment"), threadId: idSchema, workspaceSlug: optionalIdSchema, legacyRelativePath: z.string().min(1) }).strict(),
  z.object({ recordKind: z.literal("memory-source"), workspaceSlug: idSchema, legacyRelativePath: z.string().min(1) }).strict()
]);

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

export const submitBrowserAuthInputSchema = z.object({
  threadId: idSchema,
  requestId: idSchema,
  status: z.enum([
    "submitted",
    "declined",
    "cancelled",
    "unavailable",
    "expired",
    "origin_changed",
    "page_changed",
    "locator_invalid",
    "submission_failed"
  ]),
  values: z.record(z.string(), z.string()).optional()
});

export const submitDesktopActionInputSchema = z.object({
  threadId: idSchema,
  requestId: idSchema,
  decision: z.enum(["allow_once", "deny"])
});

export const submitToolPermissionInputSchema = z.object({
  threadId: idSchema,
  requestId: idSchema,
  decision: z.enum(["allow_once", "allow_always", "deny"]),
  threadPermissionMode: z.enum(["bypassPermissions"]).optional()
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

const automationJobSourceSchema = z.enum(["manual", "system"]);
const automationSystemActionSchema = z.enum(["routine", "memory_distill_workspace"]);
const automationTriggerModeSchema = z.enum(["manual", "schedule", "webhook", "chat"]);

export const automationCreateInputSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  workspaceId: z.string().optional(),
  threadId: z.string().optional(),
  schedule: automationScheduleSchema,
  triggerModes: z.array(automationTriggerModeSchema).optional(),
  source: automationJobSourceSchema.optional(),
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
  source: automationJobSourceSchema.optional(),
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

const customThemePaletteColorsSchema = z.object({
  background: z.string().regex(/^#[0-9a-f]{6}$/i),
  surface: z.string().regex(/^#[0-9a-f]{6}$/i),
  text: z.string().regex(/^#[0-9a-f]{6}$/i),
  muted: z.string().regex(/^#[0-9a-f]{6}$/i),
  accent: z.string().regex(/^#[0-9a-f]{6}$/i)
});

const customThemePaletteSchema = z.object({
  id: z.string().regex(/^custom:[a-z0-9][a-z0-9-]{0,47}$/),
  name: z.string().trim().min(1).max(32),
  light: customThemePaletteColorsSchema,
  dark: customThemePaletteColorsSchema
});

const themePaletteSchema = z.union([
  z.enum(["mint", "iris", "clay", "ocean", "sakura", "ember", "mono", "lavender", "olive"]),
  z.string().regex(/^custom:[a-z0-9][a-z0-9-]{0,47}$/)
]);

export const updateGeneralSettingsInputSchema = z.object({
  themeMode: z.enum(["system", "light", "dark"]).optional(),
  themePalette: themePaletteSchema.optional(),
  customThemePalettes: z.array(customThemePaletteSchema).max(12).optional(),
  windowBehavior: z.object({
    minimizeToTray: z.boolean().optional(),
    closeToTray: z.boolean().optional()
  }).optional(),
  updateSettings: z.object({
    autoCheckUpdates: z.boolean().optional(),
    notifyAfterDownload: z.boolean().optional(),
    installOnlyWhenIdle: z.boolean().optional(),
    lastUpdateCheckAt: z.string().nullable().optional()
  }).optional(),
  agentMessageDisplayMode: z.enum(["minimal", "verbose"]).optional()
});

export const clearCacheInputSchema = z.object({
  logs: z.boolean().optional(),
  vectorIndex: z.boolean().optional(),
  pluginsCache: z.boolean().optional()
}).strict();

export const readLogFileInputSchema = z.object({
  fileName: z.string().min(1),
  levels: z.array(z.enum(["trace", "debug", "info", "warn", "error", "fatal"])).optional(),
  query: z.string().optional(),
  maxLines: z.number().int().min(1).max(20000).optional()
}).strict();

export const lumeConfigEffectiveInputSchema = z.object({
  workspaceSlug: optionalIdSchema
});

export const getPluginAuditLogInputSchema = z.object({
  pluginId: idSchema,
  workspaceSlug: idSchema.optional(),
  limit: z.number().int().positive().optional()
});

export const verifySchema = z.object({
  method: z.enum(["tcp-port", "chrome-extension", "http-get", "none"]),
  detail: z.string().optional(),
}).strict();

// 安全加固：防止 pluginId/version/artifactPath 含 ".." 逃逸 installedRoot
const bridgePluginIdSchema = z.string().trim().min(1)
  .regex(/^[a-z0-9_.-]+$/i, "非法 pluginId")
  .refine(v => !v.includes(".."), { message: "pluginId 不得含 .. 序列" });
const bridgeVersionSchema = z.string().trim().min(1)
  .regex(/^[a-z0-9_.-]+$/i, "非法 version")
  .refine(v => !v.includes(".."), { message: "version 不得含 .. 序列" });
const bridgeArtifactPathSchema = z.string().trim().min(1).refine(
  (p) => !p.includes("..") && !p.includes("\\") && !p.startsWith("/") && !p.includes("\0"),
  { message: "artifactPath 必须是相对路径且不含 .. 或绝对路径" }
);

export const exportPluginArtifactInputSchema = z.object({
  pluginId: bridgePluginIdSchema,
  version: bridgeVersionSchema,
  artifactPath: bridgeArtifactPathSchema,
  destDir: z.string().optional(),
}).strict();

export const downloadBridgeAssetInputSchema = z.object({
  url: z.string().url().startsWith("https://"),
  filename: z.string().optional(),
  sha256: z.string().optional(),
  destDir: z.string().optional(),
}).strict();

export const checkBridgeStatusInputSchema = z.object({
  pluginId: bridgePluginIdSchema,
  version: bridgeVersionSchema,
  verify: verifySchema,
}).strict();
