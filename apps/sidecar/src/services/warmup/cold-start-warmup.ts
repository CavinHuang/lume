import { listAgentWorkspaces } from "../agent/agent-workspace-manager";
import { writeLogRecord } from "../infra/logger";
import { getWorkspaceMcpManager } from "../mcp/workspace-mcp-manager";

/**
 * 冷启动预热：把首条消息请求路径上的冷启动成本挪到应用启动后的空闲期。
 *
 * 首条消息原本要串行付出：动态 import 整个 runtime-core 模块树、
 * workspace MCP server 冷连接（stdio spawn + 握手 + listTools，npx 型 server
 * 还要拉包，可达数十秒）、工作区资产初始化。全部 fire-and-forget：
 * 任何一步失败只退化为「首条消息照旧付冷启动税」，不影响启动与请求语义——
 * 请求路径的 syncWorkspace(waitForConnections) 对已连接 server 瞬时短路。
 */
export function startColdStartWarmup(): void {
  void (async () => {
    const startedAt = Date.now();
    // 1. 预加载 runtime-core 模块树（首条消息原本要在请求路径上动态 import）
    await import("../agent-runtime/runner/attempt");
    // 2. 后台预连所有已配置 workspace 的 MCP server（不等待连接完成）
    let slugs: string[] = [];
    try {
      slugs = listAgentWorkspaces().map((workspace) => workspace.slug);
    } catch (error) {
      writeLogRecord({
        level: "warn",
        context: "sidecar.warmup",
        event: "cold_start_warmup.list_workspaces_failed",
        message: "cold start warmup could not list workspaces",
        error: { message: error instanceof Error ? error.message : String(error) }
      });
    }
    for (const slug of slugs) {
      try {
        await getWorkspaceMcpManager().syncWorkspace(slug);
      } catch (error) {
        writeLogRecord({
          level: "warn",
          context: "sidecar.warmup",
          event: "cold_start_warmup.sync_workspace_failed",
          message: "cold start warmup failed to sync workspace MCP",
          data: { workspaceSlug: slug },
          error: { message: error instanceof Error ? error.message : String(error) }
        });
      }
    }
    writeLogRecord({
      level: "info",
      context: "sidecar.warmup",
      event: "cold_start_warmup.completed",
      message: "cold start warmup completed",
      durationMs: Date.now() - startedAt,
      data: { workspaces: slugs.length }
    });
  })().catch((error) => {
    writeLogRecord({
      level: "warn",
      context: "sidecar.warmup",
      event: "cold_start_warmup.failed",
      message: "cold start warmup failed",
      error: { message: error instanceof Error ? error.message : String(error) }
    });
  });
}
