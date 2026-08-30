import { parseLumeCapabilityReference } from "@lume/agent-sdk";
import {
  fileRefSchema as sharedFileRefSchema,
  normalizeMcpTransport,
  type ProviderType,
} from "@lume/shared";
import { idSchema, optionalIdSchema, z } from "./validation";
import {
  relativeThreadPathSchema,
  rendererFileRefSchema,
} from "./schemas/shared";

export * from "./schemas/coding";
export * from "./schemas/file";
export * from "./schemas/plugin";
export * from "./schemas/resume";
export * from "./schemas/skill";
export * from "./schemas/shared";

const agentMessageAttachmentInputSchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
  mediaType: z.string().min(1),
  size: z.number().int().min(0),
  contentHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  threadPath: relativeThreadPathSchema,
  fileRef: rendererFileRefSchema.optional(),
});

const agentUserMessagePartSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("capability_ref"),
      occurrenceId: z.string().trim().min(1).max(128),
      uri: z.string().min(1).max(2048),
    })
    .strict(),
  z
    .object({
      type: z.literal("planning_todo_ref"),
      schemaVersion: z.literal(1),
      uri: z.string().regex(/^lume:\/\/planning\/todo\/[0-9a-f-]{36}$/i),
      todoId: z.string().uuid(),
      relation: z.enum(["mentioned", "primary"]),
      displayText: z.string().trim().min(1).max(240),
    })
    .strict(),
]);

const agentDiffCommentAttachmentSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    origin: z.literal("diff"),
    intent: z.enum(["comment", "context", "modify"]).optional(),
    // FileRef 形状单源 @lume/shared（#288）；diff 评论场景长度上限按现状叠加（无 trim，保持既有接受面）
    fileRef: sharedFileRefSchema
      .extend({
        scopeId: z.string().min(1).max(256),
        relativePath: z.string().max(4096),
      })
      .optional(),
    position: z
      .object({
        path: z.string().trim().min(1).max(4096),
        rootId: z.string().trim().min(1).max(128).optional(),
        runId: z.string().trim().min(1).max(128).optional(),
        side: z.enum(["left", "right"]),
        line: z.number().int().min(1),
        startLine: z.number().int().min(1).optional(),
        startSide: z.enum(["left", "right"]).optional(),
      })
      .strict(),
    body: z.string().trim().min(1).max(20_000),
    localDiffHunk: z.string().max(100_000).optional(),
    selectedContent: z
      .string()
      .max(32 * 1024)
      .optional(),
  })
  .strict();

export const agentSendInputSchema = z
  .object({
    threadId: z.string().min(1),
    userMessage: z.string(),
    messageParts: z.array(agentUserMessagePartSchema).optional(),
    clientSubmissionId: z.string().uuid().optional(),
    modelRef: z.string().optional(),
    channelId: z.string().optional(),
    modelId: z.string().optional(),
    workspaceId: z.string().optional(),
    chatType: z.enum(["direct", "group", "channel"]).optional(),
    threadType: z.enum(["main", "subagent", "group", "channel"]).optional(),
    permissionMode: z
      .enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"])
      .optional(),
    thinkingLevel: z.enum(["off", "low", "medium", "high", "max"]).optional(),
    // 三态路由字段:经 validateInput 入口时必须保留,否则 agent-service 三态路由恒走 queue
    followUpQueueMode: z.enum(["steer", "queue", "interrupt"]).optional(),
    messageAttachments: z.array(agentMessageAttachmentInputSchema).optional(),
    commentAttachments: z
      .array(agentDiffCommentAttachmentSchema)
      .max(100)
      .optional(),
    messageMetadata: z.record(z.string(), z.unknown()).optional(),
    resendFromMessageId: z.string().optional(),
    editFromMessageId: z.string().optional(),
    traceContext: z
      .object({
        submissionId: z.string().uuid(),
        clientEventId: z.string().uuid().optional(),
        traceId: z.string().uuid().optional(),
        origin: z
          .union([
            z.enum([
              "main_window",
              "quick_input",
              "automation",
              "routine",
              "subagent",
              "resume",
              "task",
              "internal",
            ]),
            z.string().regex(/^im\.[a-z0-9_-]{1,64}$/),
          ])
          .optional(),
        parentTraceId: z.string().uuid().optional(),
        parentSpanId: z.string().uuid().optional(),
        linkedTraceId: z.string().uuid().optional(),
      })
      .strict()
      .optional(),
  })
  .superRefine((input, ctx) => {
    if (!input.messageParts) return;
    const visibleMessage = input.messageParts
      .map((part) =>
        part.type === "text"
          ? part.text
          : part.type === "planning_todo_ref"
            ? `&${part.displayText}`
            : part.uri,
      )
      .join("");
    if (visibleMessage !== input.userMessage) {
      ctx.addIssue({
        code: "custom",
        path: ["messageParts"],
        message: "messageParts 必须逐字还原 userMessage",
      });
    }
    const occurrenceIds = new Set<string>();
    input.messageParts.forEach((part, index) => {
      if (part.type === "planning_todo_ref") {
        if (part.uri !== `lume://planning/todo/${part.todoId}`) {
          ctx.addIssue({
            code: "custom",
            path: ["messageParts", index, "uri"],
            message: "planning_todo_ref uri 必须与 todoId 一致",
          });
        }
        return;
      }
      if (part.type !== "capability_ref") return;
      if (occurrenceIds.has(part.occurrenceId)) {
        ctx.addIssue({
          code: "custom",
          path: ["messageParts", index, "occurrenceId"],
          message: "capability_ref occurrenceId 必须唯一",
        });
      }
      occurrenceIds.add(part.occurrenceId);
      try {
        if (!parseLumeCapabilityReference(part.uri)) {
          throw new Error("not a Lume capability reference");
        }
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["messageParts", index, "uri"],
          message: "capability_ref uri 必须是规范的 Lume 引用",
        });
      }
    });
  });

export const trustedAgentSendInputSchema = z
  .object({
    input: agentSendInputSchema,
    trustedSurface: z
      .object({
        surface: z.enum(["main", "quick-input"]),
        clientSubmissionId: z.string().uuid(),
        threadId: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const planningTodoPrioritySchema = z.enum(["none", "low", "medium", "high"]);
const planningTodoIdSchema = z.object({ todoId: z.string().uuid() }).strict();
const planningTodoRevisionSchema = planningTodoIdSchema
  .extend({ expectedRevision: z.number().int().nonnegative() })
  .strict();
const planningTodoDueSchema = z
  .object({
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    dueAt: z.number().int().nonnegative().optional(),
    dueTimezone: z.string().min(1).max(128).optional(),
  })
  .strict();
export const planningTodoListInputSchema = z
  .object({
    workspaceId: z.string().uuid().optional(),
    scope: z.enum(["current", "all", "unassigned"]).optional(),
    view: z
      .enum(["open", "today", "upcoming", "completed", "trash", "all"])
      .optional(),
    search: z.string().max(200).optional(),
    cursor: z.string().regex(/^\d+$/).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export const planningTodoGetInputSchema = planningTodoIdSchema;
export const planningTodoCreateInputSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    description: z.string().max(20_000).optional(),
    priority: planningTodoPrioritySchema.optional(),
    workspaceId: z.string().uuid().optional(),
    ...planningTodoDueSchema.shape,
  })
  .strict();
export const planningTodoUpdateInputSchema = planningTodoIdSchema
  .extend({
    expectedRevision: z.number().int().nonnegative(),
    patch: z
      .object({
        title: z.string().trim().min(1).max(500).optional(),
        description: z.string().max(20_000).nullable().optional(),
        priority: planningTodoPrioritySchema.optional(),
        workspaceId: z.string().uuid().nullable().optional(),
        dueDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/u)
          .nullable()
          .optional(),
        dueAt: z.number().int().nullable().optional(),
        dueTimezone: z.string().min(1).nullable().optional(),
      })
      .strict(),
  })
  .strict();

export const planningTodoPurgeInputSchema = planningTodoIdSchema
  .extend({
    expectedRevision: z.number().int().nonnegative(),
    confirmation: z.literal(true),
  })
  .strict();
export const planningTodoRevisionInputSchema = planningTodoRevisionSchema;
export const planningTodoStartInputSchema = planningTodoRevisionSchema
  .extend({
    workspaceId: z.string().uuid().optional(),
    idempotencyKey: z.string().min(1).max(200),
    newThread: z.boolean().optional(),
  })
  .strict();
const planningCalendarScopeSchema = z.enum(["current", "all", "unassigned"]);
const planningTimestampSchema = z.number().int().positive();
export const planningCalendarEventListInputSchema = z
  .object({
    from: planningTimestampSchema.optional(),
    to: planningTimestampSchema.optional(),
    workspaceId: z.string().uuid().optional(),
    scope: planningCalendarScopeSchema.optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();
export const planningCalendarEventIdSchema = z
  .object({ eventId: z.string().uuid() })
  .strict();
export const planningCalendarEventCreateInputSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    notes: z.string().max(20_000).optional(),
    startAt: planningTimestampSchema,
    endAt: planningTimestampSchema.optional(),
    allDay: z.boolean().optional(),
    groupId: z.string().uuid().optional(),
    tagIds: z.array(z.string().uuid()).max(50).optional(),
    reminderTimes: z.array(planningTimestampSchema).max(20).optional(),
    workspaceId: z.string().uuid().optional(),
    todoId: z.string().uuid().optional(),
  })
  .strict();
export const planningCalendarEventUpdateInputSchema =
  planningCalendarEventIdSchema
    .extend({
      expectedRevision: z.number().int().positive(),
      patch: z
        .object({
          title: z.string().trim().min(1).max(500).optional(),
          notes: z.string().max(20_000).nullable().optional(),
          startAt: planningTimestampSchema.optional(),
          endAt: planningTimestampSchema.nullable().optional(),
          allDay: z.boolean().optional(),
          groupId: z.string().uuid().nullable().optional(),
          tagIds: z.array(z.string().uuid()).max(50).optional(),
          workspaceId: z.string().uuid().nullable().optional(),
          todoId: z.string().uuid().nullable().optional(),
        })
        .strict(),
    })
    .strict();
export const planningCalendarEventDeleteInputSchema =
  planningCalendarEventIdSchema
    .extend({ expectedRevision: z.number().int().positive() })
    .strict();
export const planningGroupListInputSchema = z
  .object({ scope: z.enum(["todo", "calendar"]) })
  .strict();
export const planningGroupCreateInputSchema = z
  .object({
    scope: z.enum(["todo", "calendar"]),
    name: z.string().trim().min(1).max(100),
    color: z.string().max(64).optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();
export const planningGroupUpdateInputSchema = z
  .object({
    groupId: z.string().uuid(),
    scope: z.enum(["todo", "calendar"]),
    name: z.string().trim().min(1).max(100).optional(),
    color: z.string().max(64).nullable().optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();
export const planningEntityDeleteInputSchema = z
  .object({ id: z.string().uuid() })
  .strict();
export const planningTagCreateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    color: z.string().max(64).optional(),
  })
  .strict();
export const planningTagUpdateInputSchema = z
  .object({
    tagId: z.string().uuid(),
    name: z.string().trim().min(1).max(100).optional(),
    color: z.string().max(64).nullable().optional(),
  })
  .strict();
export const planningReminderTargetInputSchema = z
  .object({
    targetType: z.enum(["todo", "calendar_event"]),
    targetId: z.string().uuid(),
  })
  .strict();
export const planningReminderCreateInputSchema =
  planningReminderTargetInputSchema
    .extend({ triggerAt: planningTimestampSchema })
    .strict();
export const planningReminderIdSchema = z
  .object({ reminderId: z.string().uuid() })
  .strict();
export const planningReminderSnoozeInputSchema = planningReminderIdSchema
  .extend({ minutes: z.number().int().min(1).max(10_080) })
  .strict();

export const imAccountCreateInputSchema = z
  .object({
    provider: z.enum(["weixin", "dingtalk", "feishu", "wecom"]),
    accountKey: z.string().max(256).optional(),
    label: z.string().max(128).optional(),
    token: z.string().trim().min(1).max(4096),
    uin: z.string().max(128).optional(),
    workspaceId: z.string().max(256).optional(),
    baseUrl: z.string().max(2048).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const imAccountUpdateInputSchema = z.object({
  id: idSchema,
  input: z
    .object({
      accountKey: z.string().optional(),
      label: z.string().optional(),
      token: z.string().optional(),
      uin: z.string().optional(),
      workspaceId: z.string().optional(),
      baseUrl: z.string().optional(),
      enabled: z.boolean().optional(),
      status: z
        .enum(["stopped", "starting", "running", "error", "auth_required"])
        .optional(),
      cursor: z.string().optional(),
      contextToken: z.string().optional(),
      lastError: z.string().nullable().optional(),
      lastStartedAt: z.number().optional(),
      lastStoppedAt: z.number().optional(),
    })
    .strict(),
});

export const imAccountIdInputSchema = z.object({
  id: idSchema,
});

export const imWeixinLoginStartInputSchema = z
  .object({
    force: z.boolean().optional(),
    workspaceId: z.string().optional(),
  })
  .optional();

export const imWeixinLoginPollInputSchema = z.object({
  sessionKey: idSchema,
  verifyCode: z.string().optional(),
});

export const cliAuthStartInputSchema = z.object({
  provider: z.enum(["dingtalk", "feishu", "wecom"]),
});

export const cliAuthSessionInputSchema = z.object({
  sessionKey: idSchema,
});

export const imMirrorSetOwnerInputSchema = z.object({
  // null=关闭镜像（归还 owner 位）
  accountId: idSchema.nullable(),
});

// GET_SETTINGS / LIST 均无入参
export const imMirrorEmptyInputSchema = z.object({}).strict().optional();

export const imMirrorAttachCandidatesInputSchema = z.object({
  accountId: idSchema,
});

export const imMirrorAttachInputSchema = z.object({
  accountId: idSchema,
  chatId: z.string().trim().min(1),
  threadId: idSchema,
});

export const imMirrorDetachInputSchema = z.object({
  threadId: idSchema,
});

const readingSourceKindSchema = z.enum([
  "weread",
  "manual",
  "generated",
]);
const readingBookTrackSchema = z.enum(["lume", "co_read", "recommended"]);
const readingBookStatusSchema = z.enum([
  "queued",
  "reading",
  "finished",
  "paused",
]);
const readingNoteDepthSchema = z.enum(["seed", "deep"]);

const readingSourceRefSchema = z
  .object({
    kind: readingSourceKindSchema.optional(),
    externalId: z.string().optional(),
    url: z.string().optional(),
    title: z.string().optional(),
    author: z.string().optional(),
    location: z.string().optional(),
    excerpt: z.string().optional(),
  })
  .strict();

const readingQuoteEvidenceSchema = z
  .object({
    quote: z.string().min(1),
    sourceKind: readingSourceKindSchema,
    sourceId: z.string().optional(),
    sourceTitle: z.string().optional(),
    location: z.string().optional(),
    excerpt: z.string().optional(),
    url: z.string().optional(),
    capturedAt: z.number(),
  })
  .strict();

export const readingUpdateSettingsInputSchema = z
  .object({
    cadence: z.enum(["off", "weekly", "few_times_weekly", "manual"]).optional(),
    quiet: z.boolean().optional(),
    maxDeepNotesPerWeek: z.number().int().min(1).max(4).optional(),
    textModelMode: z.enum(["inherit", "explicit"]).optional(),
    textModelRef: z.string().nullable().optional(),
    imageModelRef: z.string().nullable().optional(),
    advanced: z
      .object({
        selectionModelRef: z.string().optional(),
        seedModelRef: z.string().optional(),
        deepModelRef: z.string().optional(),
        companionModelRef: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const readingAddBookInputSchema = z
  .object({
    title: z.string().min(1),
    author: z.string().optional(),
    track: readingBookTrackSchema.optional(),
    status: readingBookStatusSchema.optional(),
    source: readingSourceRefSchema.optional(),
    coverUrl: z.string().optional(),
    progressPercent: z.number().min(0).max(100).optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();

const readingUserContextSchema = z
  .object({
    userHighlights: z
      .array(
        z
          .object({
            quote: z.string().min(1),
            note: z.string().optional(),
            sourceId: z.string().optional(),
            chapterTitle: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    userThoughts: z.array(z.string()).optional(),
    memorySnippets: z.array(z.string()).optional(),
    recentConversationSnippets: z.array(z.string()).optional(),
    recentReadingNoteSnippets: z.array(z.string()).optional(),
    recentConversationSummary: z.string().optional(),
    recentDiarySummary: z.string().optional(),
  })
  .strict();

export const readingRunTaskInputSchema = z
  .object({
    trigger: z
      .enum(["manual", "scheduled", "progress", "conversation"])
      .optional(),
    bookId: z.string().optional(),
    depth: readingNoteDepthSchema.optional(),
    workspaceSlug: z.string().trim().optional(),
    userContext: readingUserContextSchema.optional(),
    manualQuoteText: z.string().optional(),
    manualSource: z.string().optional(),
  })
  .strict()
  .optional();

export const readingConnectWereadInputSchema = z
  .object({
    apiKey: z.string().trim().min(1),
    accountName: z.string().optional(),
  })
  .strict();

export const readingSearchBooksInputSchema = z
  .object({
    query: z.string().trim().min(1),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();

export const wereadApiKeyInputSchema = z
  .object({
    apiKey: z.string().trim().min(1),
  })
  .strict();

export const wereadBookIdInputSchema = z
  .object({
    bookId: z.string().trim().min(1),
  })
  .strict();

export const wereadReadDataInputSchema = z
  .object({
    period: z.string().trim().optional(),
  })
  .strict()
  .optional();

export const wereadBestBookmarksInputSchema = z
  .object({
    bookId: z.string().trim().min(1),
    bookTitle: z.string().trim().optional(),
  })
  .strict();

export const wereadPublicReviewsInputSchema = z
  .object({
    bookId: z.string().trim().min(1),
    listType: z.string().trim().optional(),
    bookTitle: z.string().trim().optional(),
  })
  .strict();

const memoryScopeSchema = z.enum(["global", "workspace"]);
const memoryScopeInputSchema = z.enum(["auto", "global", "workspace"]);
const memoryKindSchema = z.enum([
  "raw",
  "summary",
  "fact",
  "preference",
  "decision",
  "episode",
  "lesson",
  "milestone",
  "artifact",
]);
const memorySourceSchema = z.enum([
  "memory",
  "sessions",
  "session",
  "file",
  "tool",
  "manual",
]);

export const memoryReadToolInputSchema = z.object({
  workspaceSlug: idSchema,
  id: z.string().optional(),
  path: z.string().optional(),
  from: z.number().int().min(1).optional(),
  lines: z.number().int().min(1).optional(),
});

export const memoryRememberToolInputSchema = z.object({
  workspaceSlug: idSchema,
  scope: memoryScopeInputSchema.optional(),
  kind: memoryKindSchema.optional(),
  content: z.string().min(1).max(2 * 1024 * 1024),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  importance: z
    .union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
    ])
    .optional(),
  confidence: z.number().min(0).max(1).optional(),
  sourceSessionId: z.string().optional(),
  sourceMessageIds: z.array(z.string()).optional(),
  sourceToolCallId: z.string().optional(),
  threadId: z.string().optional(),
  actor: z
    .enum([
      "main_agent",
      "background_extract",
      "consolidation",
      "user",
      "migration",
    ])
    .optional(),
  explicitCorrection: z.boolean().optional(),
  requireReview: z.boolean().optional(),
});

export const memoryOrganizeHistoryInputSchema = z.object({
  workspaceSlug: idSchema,
  limit: z.number().int().min(1).max(1000).optional(),
});

export const memoryOrganizeEntriesInputSchema = z.object({
  workspaceSlug: idSchema,
});

const memoryIngestTargetScopeSchema = z.enum(["global", "workspace"]);

export const memoryIngestSourcesInputSchema = z.object({
  workspaceSlug: idSchema,
  batchMaxChars: z.number().int().min(500).max(50000).optional(),
  sources: z
    .array(
      z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("pasted_text"),
            title: z.string().trim().min(1).optional(),
            content: z.string().min(1),
            targetScope: memoryIngestTargetScopeSchema.optional(),
          })
          .strict(),
        z
          .object({
            kind: z.literal("workspace_file"),
            path: z.string().trim().min(1),
            targetScope: memoryIngestTargetScopeSchema.optional(),
          })
          .strict(),
        z
          .object({
            kind: z.literal("local_file"),
            path: z.string().trim().min(1),
            targetScope: memoryIngestTargetScopeSchema.optional(),
          })
          .strict(),
        z
          .object({
            kind: z.literal("local_folder"),
            path: z.string().trim().min(1),
            targetScope: memoryIngestTargetScopeSchema.optional(),
          })
          .strict(),
      ]),
    )
    .min(1)
    .max(20),
});

export const memoryIngestSourcesJobInputSchema = z.object({
  jobId: z.string().trim().min(1),
  workspaceSlug: idSchema.optional(),
});

export const memoryOrganizeJobInputSchema = memoryIngestSourcesJobInputSchema;
export const memoryCancelJobInputSchema = z
  .object({
    jobId: z.string().trim().min(1),
    workspaceSlug: idSchema,
  })
  .strict();

export const memoryOpenSourceInputSchema = z.object({
  workspaceSlug: idSchema,
  path: z.string().min(1),
});

export const memoryListSourceFilesInputSchema = z
  .object({
    workspaceSlug: idSchema,
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

const memoryEntryScopeSchema = z.enum(["global", "workspace"]);
const memoryEntryConfidenceSchema = z.enum(["low", "medium", "high"]);

export const memoryActivationSchema = z
  .object({
    recall: z.boolean(),
    persona: z.boolean(),
    suggestion: z.boolean(),
    analyst: z.boolean(),
  })
  .strict();

export const memoryUpdateEntryInputSchema = z
  .object({
    workspaceSlug: idSchema,
    scope: memoryEntryScopeSchema,
    id: z.string().trim().min(1),
    statement: z.string().trim().min(1).optional(),
    kind: memoryKindSchema.optional(),
    confidence: memoryEntryConfidenceSchema.optional(),
    tags: z.array(z.string()).optional(),
    activation: memoryActivationSchema.optional(),
    pinned: z.boolean().optional(),
    validTo: z.string().datetime().nullable().optional(),
    targetScope: memoryEntryScopeSchema.optional(),
    explicitCorrection: z.boolean().optional(),
  })
  .strict();

export const memoryDeleteEntryInputSchema = z
  .object({
    workspaceSlug: idSchema,
    scope: memoryEntryScopeSchema,
    id: z.string().trim().min(1),
  })
  .strict();

export const memoryUndoMutationInputSchema = z
  .object({
    workspaceSlug: idSchema,
    mutationId: z.string().uuid(),
  })
  .strict();

export const memoryResolvePendingInputSchema = z
  .object({
    workspaceSlug: idSchema,
    path: z.string().trim().min(1),
    action: z.enum(["accept", "reject", "resolve"]),
    candidateOverride: z
      .object({
        statement: z.string().trim().min(1).optional(),
        kind: memoryKindSchema.optional(),
        confidence: memoryEntryConfidenceSchema.optional(),
        tags: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const memoryToolPolicySchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
});

const memoryRetrievalConfigSchema = z
  .object({
    semantic: z.enum(["auto", "off"]).optional(),
    rerankModelRef: z.string().trim().min(1).optional(),
  })
  .strict();

export const updateMemoryRuntimeConfigInputSchema = z.object({
  tools: memoryToolPolicySchema.optional(),
  citations: z.enum(["on", "off", "auto"]).optional(),
  proactiveWrite: z.boolean().optional(),
  backgroundExtraction: z.boolean().optional(),
  autoDream: z.boolean().optional(),
  recallNotice: z.enum(["collapsed", "off"]).optional(),
  sources: z.array(z.enum(["memory", "sessions"])).optional(),
  extraPaths: z.array(z.string()).optional(),
  retrieval: memoryRetrievalConfigSchema.optional(),
});

export const agentCreateThreadInputSchema = z
  .object({
    title: z.string().optional(),
    modelRef: z.string().optional(),
    channelId: z.string().optional(),
    modelId: z.string().optional(),
    workspaceId: z.string().optional(),
    parentThreadId: z.string().optional(),
    fileContextMode: z.enum(["newRoot", "inherit", "fork"]).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.parentThreadId && input.fileContextMode !== "inherit") {
      ctx.addIssue({
        code: "custom",
        path: ["fileContextMode"],
        message: "带 parentThreadId 的子 Agent 必须显式使用 inherit",
      });
    }
    if (!input.parentThreadId && input.fileContextMode === "inherit") {
      ctx.addIssue({
        code: "custom",
        path: ["fileContextMode"],
        message: "inherit 需要 parentThreadId",
      });
    }
  });

export const agentSubmissionReceiptInputSchema = z.object({
  clientSubmissionId: idSchema,
});

export const agentReorderMessageQueueInputSchema = z.object({
  threadId: idSchema,
  orderedMessageIds: z.array(idSchema),
  expectedRevision: z.number().int().min(0),
  queueOperationId: idSchema,
});

export const agentQueuedMessageInputSchema = z.object({
  threadId: idSchema,
  queuedMessageId: idSchema,
  expectedRevision: z.number().int().min(0),
  queueOperationId: idSchema,
});

// retry 与 remove/promote 共用同一组字段,直接复用 agentQueuedMessageInputSchema
export const agentRetryQueuedMessageInputSchema = agentQueuedMessageInputSchema;

export const agentResumeQueueInputSchema = z.object({
  threadId: idSchema,
  queueOperationId: idSchema,
});

export const agentUpdateQueuedMessageInputSchema = z.object({
  threadId: idSchema,
  queuedMessageId: idSchema,
  expectedRevision: z.number().int().min(0),
  queueOperationId: idSchema,
  userMessage: z.string().max(1_000_000),
  messageParts: z.array(agentUserMessagePartSchema).optional(),
  messageAttachments: z.array(agentMessageAttachmentInputSchema).optional(),
  commentAttachments: z
    .array(agentDiffCommentAttachmentSchema)
    .max(100)
    .optional(),
});

export const agentRecentThreadMessagesInputSchema = z.object({
  threadId: idSchema,
  limit: z.number().int().min(1).max(2000),
});

export const agentGetThreadMessageVersionsInputSchema = z.object({
  threadId: idSchema,
  versionGroupId: idSchema,
});

export const agentUpdateThreadTitleInputSchema = z.object({
  threadId: idSchema,
  title: z.string().min(1),
});

export const agentListThreadWorktreesInputSchema = z.object({
  threadId: idSchema,
});

export const agentSetThreadWorktreeInputSchema = z.object({
  threadId: idSchema,
  /** null = 解绑并回到默认 cwd */
  worktreePath: z.string().min(1).nullable(),
});

export const agentUpdateThreadModelSelectionInputSchema = z.object({
  threadId: idSchema,
  modelRef: z.string().nullable().optional(),
  channelId: z.string().nullable().optional(),
  modelId: z.string().nullable().optional(),
});

export const agentListSubagentRunsInputSchema = z.object({
  ownerThreadId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  status: z
    .enum([
      "accepted",
      "running",
      "completed",
      "errored",
      "aborted",
      "timed_out",
      "canceled",
    ])
    .optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

const nonEmptyTrimmedStringSchema = z.string().trim().min(1);

const lumeConfigAgentStrategySchema = z
  .object({
    defaultChannelId: nonEmptyTrimmedStringSchema.optional(),
    defaultModelRef: nonEmptyTrimmedStringSchema.optional(),
    fallbackModelRefs: z.array(nonEmptyTrimmedStringSchema).optional(),
  })
  .strict();

const lumeConfigSubagentStrategySchema = z
  .object({
    defaultModelRef: nonEmptyTrimmedStringSchema.optional(),
  })
  .strict();

const lumeConfigRoutineStrategySchema = z
  .object({
    defaultModelRef: nonEmptyTrimmedStringSchema.optional(),
  })
  .strict();

const lumeConfigSimpleModelStrategySchema = z
  .object({
    defaultModelRef: nonEmptyTrimmedStringSchema.optional(),
  })
  .strict();

const lumeConfigAdvisorStrategySchema = z
  .object({
    enabled: z.boolean().optional(),
    defaultModelRef: nonEmptyTrimmedStringSchema.optional(),
  })
  .strict();

const lumeConfigImageGenerationStrategySchema = z
  .object({
    priorityModelRefs: z.array(nonEmptyTrimmedStringSchema).optional(),
  })
  .strict();

const lumeConfigContextWindowsSchema = z.record(
  nonEmptyTrimmedStringSchema,
  z.number().int().positive(),
);

const lumeConfigPermissionRuleSchema = z
  .object({
    id: z.string().optional(),
    tool: nonEmptyTrimmedStringSchema,
    commandPattern: z.string().optional(),
    pathPattern: z.string().optional(),
    action: z.enum(["allow", "ask", "deny"]),
    // scope 字段已从类型层删除（#519，判定逻辑从不读取）：schema 暂保留 optional
    // 以兼容旧渲染层 bundle 发来的含 scope payload（strict 下同步删除会拒收），过渡期后可移除
    scope: z.enum(["session", "workspace", "global"]).optional(),
  })
  .strict();

const lumeConfigApprovalAllowAlwaysSchema = z.enum([
  "disabled",
  "desktop-only",
  "dm-only",
]);

const lumeConfigSubagentApprovalSchema = z
  .object({
    mode: z.enum(["inherit", "ask-parent", "deny-high-risk"]).optional(),
    allowAlways: z.enum(["disabled", "desktop-only", "parent-only"]).optional(),
  })
  .strict();

const lumeConfigImAccountApprovalSchema = z
  .object({
    enabled: z.boolean().optional(),
    allowTextApprove: z.boolean().optional(),
    allowAlways: lumeConfigApprovalAllowAlwaysSchema.optional(),
    groupApproval: z.enum(["disabled", "desktop-only"]).optional(),
    approverPeerIds: z.array(nonEmptyTrimmedStringSchema).optional(),
  })
  .strict();

const lumeConfigImApprovalSchema = z
  .object({
    enabled: z.boolean().optional(),
    allowTextApprove: z.boolean().optional(),
    allowAlways: lumeConfigApprovalAllowAlwaysSchema.optional(),
    groupApproval: z.enum(["disabled", "desktop-only"]).optional(),
    accounts: z
      .record(z.string(), lumeConfigImAccountApprovalSchema)
      .optional(),
  })
  .strict();

const lumeConfigPermissionApprovalsSchema = z
  .object({
    desktop: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
    subagent: lumeConfigSubagentApprovalSchema.optional(),
    im: lumeConfigImApprovalSchema.optional(),
  })
  .strict();

const lumeConfigPermissionsSchema = z
  .object({
    toolPolicy: z
      .object({
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    rules: z.array(lumeConfigPermissionRuleSchema).optional(),
    classifier: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
    privateWriteRoots: z.array(z.string()).optional(),
    approvals: lumeConfigPermissionApprovalsSchema.optional(),
  })
  .strict();

const lumeConfigWebSearchProviderSchema = z
  .object({
    enabled: z.boolean().optional(),
    apiKey: z.string().trim().min(1).optional(),
  })
  .strict();

const lumeConfigWebSearchSchema = z
  .object({
    strategy: z.enum(["priority", "joint"]).optional(),
    providers: z
      .object({
        exa: lumeConfigWebSearchProviderSchema.optional(),
        pipellm: lumeConfigWebSearchProviderSchema.optional(),
        zhipu: lumeConfigWebSearchProviderSchema.optional(),
        tavily: lumeConfigWebSearchProviderSchema.optional(),
        brave: lumeConfigWebSearchProviderSchema.optional(),
        duckduckgo: lumeConfigWebSearchProviderSchema.optional(),
        bing: lumeConfigWebSearchProviderSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const lumeConfigUpdateBaseSchema = z.object({
  source: z.enum(["user", "agent", "system"]),
  workspaceSlug: optionalIdSchema,
  summary: z.string().optional(),
});

export const lumeConfigUpdateInputSchema = z.union([
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("models.agent"),
    value: lumeConfigAgentStrategySchema,
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("models.subagent"),
    value: lumeConfigSubagentStrategySchema,
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("models.routine"),
    value: lumeConfigRoutineStrategySchema,
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("models.advisor"),
    value: lumeConfigAdvisorStrategySchema,
  }),
  ...[
    "models.background",
    "models.contextCompression",
    "models.title",
    "models.welcomeSuggestions",
    "models.permissionClassifier",
    "models.memoryJudgement",
  ].map((path) =>
    lumeConfigUpdateBaseSchema.extend({
      path: z.literal(path),
      value: lumeConfigSimpleModelStrategySchema,
    }),
  ),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("models.imageGeneration"),
    value: lumeConfigImageGenerationStrategySchema,
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("models.contextWindows"),
    value: lumeConfigContextWindowsSchema,
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("models.agent.defaultChannelId"),
    value: nonEmptyTrimmedStringSchema,
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("models.agent.defaultModelRef"),
    value: nonEmptyTrimmedStringSchema,
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("models.agent.fallbackModelRefs"),
    value: z.array(nonEmptyTrimmedStringSchema),
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("models.subagent.defaultModelRef"),
    value: nonEmptyTrimmedStringSchema,
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("models.routine.defaultModelRef"),
    value: nonEmptyTrimmedStringSchema,
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("models.embedding.defaultModelRef"),
    value: nonEmptyTrimmedStringSchema,
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("memory.extraction.modelRef"),
    value: z.string().nullable(),
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("agent.thinkingLevel"),
    value: z.enum(["off", "low", "medium", "high", "max"]).nullable(),
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("agent.projectInstructionsEnabled"),
    value: z.boolean(),
  }),
  lumeConfigUpdateBaseSchema.extend({
    // 存量缺口:输入框队列模式选择器的保存(updateAgentFollowUpQueueMode)一直
    // 因缺此 union 成员被参数校验拒绝(#715 review 发现)
    path: z.literal("agent.followUpQueueMode"),
    value: z.enum(["steer", "queue", "interrupt"]).nullable(),
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("agent.permissionMode"),
    value: z
      .enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"])
      .nullable(),
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("permissions"),
    value: lumeConfigPermissionsSchema,
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("permissions.approvals"),
    value: lumeConfigPermissionApprovalsSchema,
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("permissions.classifier.enabled"),
    value: z.boolean(),
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("webSearch"),
    value: lumeConfigWebSearchSchema,
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("obsidian.enabled"),
    value: z.boolean(),
  }),
  lumeConfigUpdateBaseSchema.extend({
    path: z.literal("obsidian.extraVaults"),
    value: z.array(z.string().trim().min(1)),
  }),
]);

export const workspaceCreateInputSchema = z.object({
  projectPath: z.string().trim().min(1),
  name: z.string().min(1).optional(),
});

export const workspaceUpdateInputSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
});

export const workspaceIdInputSchema = z.object({
  id: idSchema,
});

export const workspaceBranchCheckoutInputSchema = z.object({
  id: idSchema,
  branch: z.string().trim().min(1).max(200),
  /** true = 创建并检出新分支；缺省 = 切换到已有本地分支 */
  create: z.boolean().optional(),
});

export const workspaceGitLogInputSchema = z.object({
  id: idSchema,
  limit: z.number().int().min(1).max(1000).optional(),
});

export const workspaceDirectoryInputSchema = z.object({
  id: idSchema,
  projectPath: z.string().trim().min(1),
});

export const workspaceDeleteInputSchema = z.object({
  id: idSchema,
  mode: z.enum(["keepHistory", "deleteLumeData"]),
});

const mcpServerEntrySchema = z
  .object({
    transport: z.enum(["stdio", "streamable_http", "sse"]).optional(),
    type: z.enum(["stdio", "http", "sse", "streamable_http"]).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    disabledTools: z.array(z.string()).optional(),
    enabled: z.boolean(),
  })
  .superRefine((entry, ctx) => {
    const transport = normalizeMcpTransport(entry);
    if (!transport) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transport"],
        message: "MCP server requires transport or legacy type",
      });
      return;
    }

    if (transport === "stdio" && !entry.command?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["command"],
        message: "stdio MCP server requires command",
      });
    }

    if (
      (transport === "streamable_http" || transport === "sse") &&
      !entry.url?.trim()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: "remote MCP server requires url",
      });
    }
  });

export const workspaceMcpConfigInputSchema = z.object({
  workspaceSlug: idSchema,
  config: z
    .object({
      servers: z.record(z.string(), mcpServerEntrySchema),
    })
    .default({ servers: {} }),
});

export const mcpStatusInputSchema = z.object({
  workspaceSlug: idSchema,
  waitForConnections: z.boolean().optional(),
});

export const mcpTestServerInputSchema = z.object({
  workspaceSlug: idSchema,
  serverId: idSchema,
});

export const mcpListResourcesInputSchema = z.object({
  workspaceSlug: idSchema,
  serverId: idSchema.optional(),
});

export const mcpReadResourceInputSchema = z.object({
  workspaceSlug: idSchema,
  serverId: idSchema,
  uri: z.string().min(1),
});

export const mcpCallToolDiagnosticInputSchema = z.object({
  workspaceSlug: idSchema,
  serverId: idSchema,
  originalToolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  timeoutMs: z.number().int().positive().optional(),
});

export const submitAskUserQuestionInputSchema = z.object({
  threadId: idSchema,
  toolUseId: idSchema,
  canceled: z.boolean().optional(),
  answers: z.record(z.string(), z.string()).optional(),
});

export const submitDesktopActionInputSchema = z.object({
  threadId: idSchema,
  requestId: idSchema,
  decision: z.enum(["allow_once", "deny"]),
});

export const submitToolPermissionInputSchema = z.object({
  threadId: idSchema,
  requestId: idSchema,
  decision: z.enum(["allow_once", "allow_always", "deny"]),
  // #558:「始终允许」作用域档位——缺省 exact;不声明会被 zod strip 静默丢弃
  allowAlwaysScope: z.enum(["exact", "command", "tool"]).optional(),
  threadPermissionMode: z.enum(["bypassPermissions"]).optional(),
});

// #775:持久工具授权查看/撤销面板
export const listToolPermissionGrantsInputSchema = z.object({});

export const revokeToolPermissionGrantInputSchema = z
  .object({
    ids: z.array(idSchema).optional(),
    workspaceSlug: z.string().min(1).optional(),
  })
  .refine((input) => (input.ids?.length ?? 0) > 0 || !!input.workspaceSlug, {
    message: "需提供 ids 或 workspaceSlug 之一",
  });

export const pendingInteractiveInputSchema = z.object({
  threadId: z.string().optional(),
});

export const threadRunEventsInputSchema = z.object({
  threadId: idSchema,
});

export const proxySettingsInputSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  mode: z.enum(["off", "system", "custom"]),
  httpProxy: z.string().optional(),
  httpsProxy: z.string().optional(),
  noProxy: z.string().optional(),
});

const automationScheduleSchema = z.object({
  type: z.enum(["cron", "once", "interval", "manual"]),
  cronExpr: z.string().optional(),
  runAt: z.number().optional(),
  intervalMs: z.number().optional(),
  timezone: z.string().optional(),
});

const automationJobSourceSchema = z.enum(["manual", "system"]);
const automationSystemActionSchema = z.enum([
  "routine",
  "memory_distill_workspace",
]);
const automationTriggerModeSchema = z.enum([
  "manual",
  "schedule",
  "webhook",
  "chat",
]);

// #647 P2-23：source/systemAction 不接受渲染进程输入——它们决定无人值守
// bypassPermissions 授权，只能由 sidecar 内部调用方（routine-executor 等）经
// manager 直写；CREATE 处理器服务端强制 source:"manual"。
export const automationCreateInputSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  workspaceId: z.string().optional(),
  threadId: z.string().optional(),
  schedule: automationScheduleSchema,
  triggerModes: z.array(automationTriggerModeSchema).optional(),
  description: z.string().optional(),
  defaultModel: z.string().optional(),
  // P2-19：此前被 zod 非严格 object 静默剥离，UI 选了存不下来
  thinkingLevel: z.enum(["off", "low", "medium", "high", "max"]).optional(),
  toolResourceIds: z.array(z.string()).optional(),
  prompt: z.string().min(1),
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
  thinkingLevel: z.enum(["off", "low", "medium", "high", "max"]).optional(),
  toolResourceIds: z.array(z.string()).optional(),
  prompt: z.string().min(1).optional(),
});

export const automationDeleteInputSchema = z.object({
  id: idSchema,
});

export const automationListRunsInputSchema = z.object({
  jobId: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export const automationRunNowInputSchema = z.object({
  id: idSchema,
});

export const automationToggleInputSchema = z.object({
  id: idSchema,
});

const customThemePaletteColorsSchema = z.object({
  background: z.string().regex(/^#[0-9a-f]{6}$/i),
  surface: z.string().regex(/^#[0-9a-f]{6}$/i),
  text: z.string().regex(/^#[0-9a-f]{6}$/i),
  muted: z.string().regex(/^#[0-9a-f]{6}$/i),
  accent: z.string().regex(/^#[0-9a-f]{6}$/i),
});

const customThemePaletteSchema = z.object({
  id: z.string().regex(/^custom:[a-z0-9][a-z0-9-]{0,47}$/),
  name: z.string().trim().min(1).max(32),
  light: customThemePaletteColorsSchema,
  dark: customThemePaletteColorsSchema,
});

const themePaletteSchema = z.union([
  z.enum([
    "mint",
    "iris",
    "clay",
    "ocean",
    "sakura",
    "ember",
    "mono",
    "lavender",
    "olive",
  ]),
  z.string().regex(/^custom:[a-z0-9][a-z0-9-]{0,47}$/),
]);

export const updateGeneralSettingsInputSchema = z.object({
  themeMode: z.enum(["system", "light", "dark"]).optional(),
  themePalette: themePaletteSchema.optional(),
  customThemePalettes: z.array(customThemePaletteSchema).max(12).optional(),
  windowBehavior: z
    .object({
      minimizeToTray: z.boolean().optional(),
      closeToTray: z.boolean().optional(),
      showTray: z.boolean().optional(),
    })
    .optional(),
  agentIsland: z
    .object({
      enabled: z.boolean().optional(),
    })
    .optional(),
  updateSettings: z
    .object({
      autoCheckUpdates: z.boolean().optional(),
      notifyAfterDownload: z.boolean().optional(),
      installOnlyWhenIdle: z.boolean().optional(),
      lastUpdateCheckAt: z.string().nullable().optional(),
    })
    .optional(),
  agentMessageDisplayMode: z.enum(["minimal", "verbose"]).optional(),
  agentMessageListDisplayMode: z
    .enum(["conversation", "left_aligned"])
    .optional(),
  agentMessageAvatarMode: z.enum(["visible", "hidden"]).optional(),
  chatFontScale: z.enum(["sm", "md", "lg"]).optional(),
});

export const clearCacheInputSchema = z
  .object({
    logs: z.boolean().optional(),
    vectorIndex: z.boolean().optional(),
    pluginsCache: z.boolean().optional(),
  })
  .strict();

export const readLogFileInputSchema = z
  .object({
    fileName: z.string().min(1),
    levels: z
      .array(z.enum(["trace", "debug", "info", "warn", "error", "fatal"]))
      .optional(),
    query: z.string().optional(),
    maxLines: z.number().int().min(1).max(20000).optional(),
  })
  .strict();

export const lumeConfigEffectiveInputSchema = z.object({
  workspaceSlug: optionalIdSchema,
});


// ---------------------------------------------------------------------------
// Channel 系 RPC 入参（#155：此前 channel-handlers 全裸 cast，畸形入参 TypeError + 任意字段持久化）
// 枚举为 shared 字面量 union 的运行时镜像（shared 无 const 数组）；新增 ProviderType 需同步此处
// ---------------------------------------------------------------------------
const channelProviderTypeSchema = z.enum([
  "anthropic", "anthropic-compatible", "openai", "openai-codex", "github-copilot", "xai", "jina",
  "siliconflow", "openrouter", "deepseek", "google", "zai", "zai-coding-plan", "moonshot",
  "minimax", "minimax-cn", "doubao", "qwen", "qwen-portal", "kimi-coding", "ollama", "lmstudio",
  "opencode", "custom", "aliyun-coding-plan", "volcengine-coding-plan", "minimax-token-plan",
  "xiaomi-token-plan", "stepfun", "stepfun-coding-plan"
] as const satisfies readonly ProviderType[]);
const channelProtocolSchema = z.enum([
  "openai-completions", "openai-responses", "openai-codex-responses", "anthropic-messages", "google-generative-ai"
] as const);
const channelAuthTypeSchema = z.enum(["api-key", "oauth", "none"] as const);
const channelApiFamilySchema = z.enum(["anthropic", "openai", "google"] as const);
const channelOpenAiApiModeSchema = z.enum(["chat-completions", "responses"] as const);
const channelHealthStatusSchema = z.enum(["unknown", "available", "unavailable"] as const);
const channelSyncStatusSchema = z.enum(["idle", "syncing", "success", "error"] as const);

const channelModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  alias: z.string().optional(),
  capabilities: z.object({
    chat: z.boolean().optional(),
    embedding: z.boolean().optional(),
    vision: z.boolean().optional(),
    tool: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    rerank: z.boolean().optional(),
    image: z.boolean().optional()
  }).strict().optional(),
  protocol: channelProtocolSchema.optional(),
  source: z.enum(["discovered", "manual"]).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  enabled: z.boolean()
}).strict();

export const channelCreateInputSchema = z.object({
  name: z.string().min(1),
  provider: channelProviderTypeSchema,
  protocol: channelProtocolSchema.optional(),
  authType: channelAuthTypeSchema.optional(),
  accountLabel: z.string().optional(),
  baseUrl: z.string().min(1),
  // 明文 API Key；未修改时 renderer 传空串，不得加 min(1)
  apiKey: z.string(),
  models: z.array(channelModelSchema),
  defaultModelId: z.string().optional(),
  fallbackModelIds: z.array(z.string()).optional(),
  apiFamily: channelApiFamilySchema.optional(),
  openaiApiMode: channelOpenAiApiModeSchema.optional(),
  providerId: z.string().optional(),
  enabled: z.boolean()
}).strict();

export const channelUpdateInputSchema = channelCreateInputSchema.partial().extend({
  healthStatus: channelHealthStatusSchema.optional(),
  healthMessage: z.string().optional(),
  lastTestedAt: z.number().optional(),
  syncStatus: channelSyncStatusSchema.optional(),
  syncMessage: z.string().optional(),
  lastSyncedAt: z.number().optional()
}).strict();

export const channelUpdateParamsSchema = z.object({
  id: idSchema,
  input: channelUpdateInputSchema
}).strict();

export const channelDeleteParamsSchema = z.object({ id: idSchema }).strict();

export const fetchModelsInputSchema = z.object({
  provider: channelProviderTypeSchema,
  baseUrl: z.string().min(1),
  apiKey: z.string(),
  apiFamily: channelApiFamilySchema.optional(),
  openaiApiMode: channelOpenAiApiModeSchema.optional()
}).strict();

export const channelIdParamsSchema = z.object({ channelId: idSchema }).strict();

export const connectionIdParamsSchema = z.object({ connectionId: idSchema }).strict();

export const oauthSessionIdParamsSchema = z.object({ sessionId: idSchema }).strict();

export const oauthAnswerParamsSchema = z.object({
  sessionId: idSchema,
  promptId: idSchema,
  value: z.string().optional()
}).strict();

export const oauthCancelParamsSchema = z.object({ sessionId: idSchema.optional() }).strict();

// ---------------------------------------------------------------------------
// #522 裸 cast 收口：此前八处跨进程入参绕过 validateInput 体系，破坏
// "入参非法即 throw" 契约。逐处补 schema 后统一走 validateInput。
// ---------------------------------------------------------------------------

export const forkThreadInputSchema = z.object({
  threadId: idSchema,
  upToMessageId: idSchema,
}).strict();

export const routineGetByDateInputSchema = z.object({
  date: z.string().min(1),
}).strict();

export const routineTriggerEntryInputSchema = z.object({
  entryId: z.string().min(1),
}).strict();

export const testSearchBackendInputSchema = z.object({
  provider: z.enum(["exa", "tavily", "brave", "duckduckgo", "pipellm", "zhipu", "bing"]),
  apiKey: z.string().optional(),
}).strict();

export const githubReleaseListOptionsSchema = z.object({
  perPage: z.number().int().positive().optional(),
  page: z.number().int().positive().optional(),
  includePrerelease: z.boolean().optional(),
}).strict();

export const agentGenerateTitleInputSchema = z.object({
  sourceText: z.string().optional(),
  userMessage: z.string().optional(),
  modelRef: z.string().optional(),
  channelId: z.string().optional(),
  modelId: z.string().optional(),
}).strict();

export const agentWelcomeSuggestionInputSchema = z.object({
  workspaceSlug: z.string().optional(),
  workspaceName: z.string().optional(),
}).strict();

export const desktopAssistantSettingsInputSchema = z.object({
  enabled: z.boolean(),
  allowedApps: z.array(z.string()),
  retentionHours: z.number(),
  maxStorageBytes: z.number(),
  proactiveEnabled: z.boolean().optional(),
  notificationsEnabled: z.boolean().optional(),
  dailyWrapEnabled: z.boolean().optional(),
});
