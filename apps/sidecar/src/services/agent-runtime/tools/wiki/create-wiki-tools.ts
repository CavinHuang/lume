import type { ToolDefinition } from "@lume/agent-sdk";
import type { WikiSearchScope } from "@lume/shared";
import { getWikiService } from "../../../wiki/wiki-service";
import { createSdkJsonResultTool } from "../sdk-tool-result";

export function createWikiReadTools(scope: WikiSearchScope): ToolDefinition[] {
  const service = getWikiService();
  const subject = service.ownerSubject();
  return [
    createSdkJsonResultTool({
      name: "wiki.search",
      description: "在当前 Ask Wiki 会话获准的范围内搜索页面。不会读取范围外页面，也不会修改 Wiki。",
      inputSchema: { type: "object", properties: { query: { type: "string" }, maxResults: { type: "number", minimum: 1, maximum: 50 } }, required: ["query"] },
      isReadOnly: true,
      isConcurrencySafe: true,
      async call(input) {
        return service.search({ query: String(input.query ?? ""), scope, maxResults: typeof input.maxResults === "number" ? input.maxResults : 10 }, subject);
      },
    }),
    createSdkJsonResultTool({
      name: "wiki.read",
      description: "读取获准范围内的 Wiki 页面及其可访问来源、链接和反向链接。受限原始来源会明确标记。",
      inputSchema: { type: "object", properties: { pageId: { type: "string" } }, required: ["pageId"] },
      isReadOnly: true,
      isConcurrencySafe: true,
      async call(input) { return service.read(String(input.pageId ?? ""), scope, subject); },
    }),
    createSdkJsonResultTool({
      name: "wiki.follow_links",
      description: "沿获准页面的 Wiki links 读取相关页面，最多三层，不会跨越会话 scope。",
      inputSchema: { type: "object", properties: { pageId: { type: "string" }, depth: { type: "number", minimum: 1, maximum: 3 } }, required: ["pageId"] },
      isReadOnly: true,
      isConcurrencySafe: true,
      async call(input) { return service.followLinks(String(input.pageId ?? ""), scope, subject, typeof input.depth === "number" ? input.depth : 1); },
    }),
  ];
}
