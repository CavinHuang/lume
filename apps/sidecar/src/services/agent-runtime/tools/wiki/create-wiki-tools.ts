import type { ToolDefinition } from "@lume/agent-sdk";
import type { WikiSearchScope, WikiTrustedSubject } from "@lume/shared";
import { listAgentWorkspaces } from "../../../agent/agent-workspace-manager";
import type { WikiService } from "../../../wiki/wiki-service";
import { createSdkJsonResultTool } from "../sdk-tool-result";

export function createWikiReadTools(scope: WikiSearchScope): ToolDefinition[] {
  return [
    createSdkJsonResultTool({
      name: "wiki.search",
      description: "在当前会话获准的 Wiki 范围内搜索页面。不会读取范围外页面，也不会修改 Wiki。",
      inputSchema: { type: "object", properties: { query: { type: "string" }, maxResults: { type: "number", minimum: 1, maximum: 50 } }, required: ["query"] },
      isReadOnly: true,
      isConcurrencySafe: true,
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
      async call(input) {
        const { service, subject } = await getWikiContext(scope);
        return service.followLinks(String(input.pageId ?? ""), scope, subject, typeof input.depth === "number" ? input.depth : 1);
      },
    }),
  ];
}

export function createWikiProposalTool(scope: WikiSearchScope): ToolDefinition {
  return createSdkJsonResultTool({
    name: "wiki.propose_changes",
    description: "创建一个待用户确认的 Wiki 变更草案。它只写入 staging，不会修改正式 Wiki，也不能代替用户确认。更新前必须先 wiki.read 并提供 expectedHash。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "update"] },
        title: { type: "string" },
        body: { type: "string" },
        pageType: { type: "string", enum: ["topic", "decision", "synthesis"] },
        pageId: { type: "string" },
        expectedHash: { type: "string" },
        primaryWorkspaceId: { type: ["string", "null"] }
      },
      required: ["action", "title", "body"]
    },
    isReadOnly: false,
    isConcurrencySafe: false,
    async call(input) {
      const { service, subject } = await getWikiContext(scope);
      const action = input.action === "update" ? "update" : input.action === "create" ? "create" : undefined;
      if (!action) throw new Error("action 必须是 create 或 update");
      const pageType = input.pageType === "topic" || input.pageType === "decision" || input.pageType === "synthesis"
        ? input.pageType
        : undefined;
      return service.createAgentProposalDraft({
        action,
        title: String(input.title ?? ""),
        body: String(input.body ?? ""),
        ...(pageType ? { pageType } : {}),
        ...(typeof input.pageId === "string" ? { pageId: input.pageId } : {}),
        ...(typeof input.expectedHash === "string" ? { expectedHash: input.expectedHash } : {}),
        ...(typeof input.primaryWorkspaceId === "string" || input.primaryWorkspaceId === null
          ? { primaryWorkspaceId: input.primaryWorkspaceId }
          : {})
      }, scope, subject);
    }
  });
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
