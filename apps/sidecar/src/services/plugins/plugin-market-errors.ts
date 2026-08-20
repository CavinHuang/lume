/**
 * 市场服务公共错误类型(#177 自 plugin-market-service.ts 拆出,纯移动):
 * github 适配层与服务本体共用,置于叶模块避免环。
 */
import type { AgentPluginDiagnostic } from "@lume/shared";

export class PluginMarketError extends Error {
  constructor(
    public readonly code:
      | "source_not_found"
      | "network_failed"
      | "invalid_manifest"
      | "invalid_skill"
      | "permission_review_required"
      | "permission_review_cancelled"
      | "install_failed"
      | "uninstall_blocked"
      | "not_installed"
      | "already_installed",
    message: string,
    public readonly diagnostics?: AgentPluginDiagnostic[],
  ) {
    super(message);
    this.name = "PluginMarketError";
  }
}
