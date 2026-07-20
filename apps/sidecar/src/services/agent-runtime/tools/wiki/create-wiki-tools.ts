import type { ToolDefinition } from "@lume/agent-sdk";
import type { WikiBlockPatch, WikiSearchScope, WikiTrustedSubject } from "@lume/shared";
import { listAgentWorkspaces } from "../../../agent/agent-workspace-manager";
import type { WikiService } from "../../../wiki/wiki-service";
import { createSdkJsonResultTool } from "../sdk-tool-result";

export function createWikiReadTools(scope: WikiSearchScope): ToolDefinition[] {
  const runtimeMetadata = {
    source: "lume",
    category: "read",
    capability: "filesystem",
    riskLevel: "low",
    sideEffects: "local_read",
    allowedInPlanMode: true,
    isReadOnly: true,
    isConcurrencySafe: true,
    requiresApprovalByDefault: false
  } as const;
  return [
    createSdkJsonResultTool({
      name: "wiki.search",
      description: "在当前会话获准的 Wiki 范围内搜索页面。不会读取范围外页面，也不会修改 Wiki。",
      inputSchema: { type: "object", properties: { query: { type: "string" }, maxResults: { type: "number", minimum: 1, maximum: 50 } }, required: ["query"] },
      isReadOnly: true,
      isConcurrencySafe: true,
      runtimeMetadata,
      async call(input) {
        const { service, subject } = await getWikiContext(scope);
        return service.search({ query: String(input.query ?? ""), scope, maxResults: typeof input.maxResults === "number" ? input.maxResults : 10 }, subject);
      },
    }),
    createSdkJsonResultTool({
      name: "wiki.read",
      description: "读取获准范围内的 Wiki 页面及其可访问来源、链接和反向链接。受限原始来源会明确标记。",
      inputSchema: { type: "object", properties: { pageId: { type: "string" } }, required: ["pageId"] },
      isReadOnly: true,
      isConcurrencySafe: true,
      runtimeMetadata,
      async call(input) {
        const { service, subject } = await getWikiContext(scope);
        return service.read(String(input.pageId ?? ""), scope, subject);
      },
    }),
    createSdkJsonResultTool({
      name: "wiki.follow_links",
      description: "沿获准页面的 Wiki links 读取相关页面，最多三层，不会跨越会话 scope。",
      inputSchema: { type: "object", properties: { pageId: { type: "string" }, depth: { type: "number", minimum: 1, maximum: 3 } }, required: ["pageId"] },
      isReadOnly: true,
      isConcurrencySafe: true,
      runtimeMetadata,
      async call(input) {
        const { service, subject } = await getWikiContext(scope);
        return service.followLinks(String(input.pageId ?? ""), scope, subject, typeof input.depth === "number" ? input.depth : 1);
      },
    }),
  ];
}

export function createWikiProposalTool(
  scope: WikiSearchScope,
  options: { createOnly?: boolean; creatorThreadId?: string; creatorProfile?: "ask-wiki" | "ordinary-agent" } = {}
): ToolDefinition {
  const createOnly = options.createOnly === true;
  const tool = createSdkJsonResultTool({
    name: "wiki.propose_changes",
    description: createOnly
      ? "为用户明确要求沉淀的内容创建一个待确认的新 Wiki 页面草案。它只写入 staging，不会修改正式 Wiki；创建后必须等待用户在确认卡中确认。"
      : "创建一个待用户确认的 Wiki 变更草案。它只写入 staging，不会修改正式 Wiki，也不能代替用户确认。更新前必须先 wiki.read 并提供 expectedHash。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: createOnly ? ["create"] : ["create", "update", "replace_page"] },
        title: { type: "string" },
        body: { type: "string" },
        pageType: { type: "string", enum: ["topic", "decision", "synthesis"] },
        pageId: { type: "string" },
        expectedHash: { type: "string" },
        patches: {
          type: "array",
          items: {
            type: "object",
            properties: {
              blockId: { type: "string" },
              expectedContentHash: { type: "string" },
              action: { type: "string", enum: ["update", "delete"] },
              content: { type: "string" },
            },
            required: ["blockId", "expectedContentHash", "action"],
          },
        },
        primaryWorkspaceId: { type: ["string", "null"] }
      },
      required: ["action"]
    },
    isReadOnly: false,
    isConcurrencySafe: false,
    runtimeMetadata: {
      source: "lume",
      category: "control",
      capability: "planning",
      riskLevel: "low",
      sideEffects: "local_write",
      allowedInPlanMode: true,
      isReadOnly: false,
      isConcurrencySafe: false,
      requiresApprovalByDefault: false
    },
    async call(input) {
      const action = input.action === "update" || input.action === "create" || input.action === "replace_page" ? input.action : undefined;
      if (!action) throw new Error("action 必须是 create、update 或 replace_page");
      if (createOnly && action === "update") throw new Error("当前会话只能新建 Wiki 草案；请在 Wiki 会话中读取原页面后再更新");
      if (createOnly && action === "replace_page") throw new Error("当前会话只能新建 Wiki 草案；整页重写只能在 Wiki 会话中送审");
      const { service, subject } = await getWikiContext(scope);
      const pageType = input.pageType === "topic" || input.pageType === "decision" || input.pageType === "synthesis"
        ? input.pageType
        : undefined;
      const draft = service.createAgentProposalDraft({
        action,
        ...(typeof input.title === "string" ? { title: input.title } : {}),
        ...(typeof input.body === "string" ? { body: input.body } : {}),
        ...(Array.isArray(input.patches) ? { patches: input.patches.map(parseBlockPatch) } : {}),
        ...(pageType ? { pageType } : {}),
        ...(typeof input.pageId === "string" ? { pageId: input.pageId } : {}),
        ...(typeof input.expectedHash === "string" ? { expectedHash: input.expectedHash } : {}),
        ...(typeof input.primaryWorkspaceId === "string" || input.primaryWorkspaceId === null
          ? { primaryWorkspaceId: input.primaryWorkspaceId }
          : {})
      }, scope, subject, {
        subjectId: subject.subjectId,
        ...(options.creatorThreadId ? { threadId: options.creatorThreadId } : {}),
        profile: options.creatorProfile ?? "ordinary-agent",
        scope,
        channel: "agent",
      });
      return service.coordinator.getProposalSummary(draft.id);
    }
  });
  return tool;
}

function parseBlockPatch(value: unknown): WikiBlockPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("patch 必须是对象");
  const input = value as Record<string, unknown>;
  const action = input.action === "update" || input.action === "delete" ? input.action : undefined;
  if (!action || typeof input.blockId !== "string" || typeof input.expectedContentHash !== "string") {
    throw new Error("patch 缺少 blockId、expectedContentHash 或合法 action");
  }
  return {
    blockId: input.blockId,
    expectedContentHash: input.expectedContentHash,
    action,
    ...(typeof input.content === "string" ? { content: input.content } : {}),
  };
}

async function getWikiContext(scope: WikiSearchScope): Promise<{ service: WikiService; subject: WikiTrustedSubject }> {
  const { getWikiService } = await import("../../../wiki/wiki-service");
  const service = getWikiService();
  return { service, subject: createWikiAgentSubject(scope, service) };
}

function createWikiAgentSubject(scope: WikiSearchScope, service: WikiService): WikiTrustedSubject {
  const page = scope.kind === "page" ? service.coordinator.markdown.readById(scope.pageId) : undefined;
  const workspaceIds = scope.kind === "workspace"
    ? [scope.workspaceId]
    : scope.kind === "all"
      ? listAgentWorkspaces().map((workspace) => workspace.id)
      : page
        ? [page.primaryWorkspaceId, ...page.associatedWorkspaceIds].filter((id): id is string => Boolean(id))
        : [];
  return {
    kind: "desktop_agent",
    subjectId: "local-desktop-agent",
    workspaceIds: [...new Set(workspaceIds)],
    allowInbox: scope.kind === "inbox" || (scope.kind === "page" && page?.primaryWorkspaceId === null),
    allowAll: scope.kind === "all"
  };
}
