import { listAgentWorkspaces } from "../agent/agent-workspace-manager";
import { createLogger } from "../infra/logger";
import { recoverBackgroundMemoryExtractionJobs } from "./background-extractor";
import { recoverInterruptedConsolidation } from "./consolidation";
import { memoryJobService } from "./job-service";

const log = createLogger("memory-v2.job-recovery");

export function recoverMemoryJobsForWorkspace(workspaceSlug: string): void {
  memoryJobService.recoverInterrupted(workspaceSlug);
  recoverBackgroundMemoryExtractionJobs(workspaceSlug);
  recoverInterruptedConsolidation(workspaceSlug);
}

export function recoverMemoryJobsOnStartup(): void {
  for (const workspace of listAgentWorkspaces()) {
    try {
      recoverMemoryJobsForWorkspace(workspace.slug);
    } catch (error) {
      log.warn("memory job recovery failed", {
        workspaceSlug: workspace.slug,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
