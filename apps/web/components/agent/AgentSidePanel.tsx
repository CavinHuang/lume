/**
 * Migrated from:
 * /Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/agent/SidePanel.tsx
 * Adaptation:
 * - Lume 使用简化双 Tab 侧面板（Team + Files），复用现有 FileBrowser。
 * - Team 面板数据来自消息事件重建 + subagent run IPC 轮询合并。
 */

"use client";

import * as React from "react";
import { FolderOpen, PanelRight, Users, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { FileBrowser } from "@/components/file-browser";
import type { ToolActivity } from "@/atoms/agent-atoms";
import { TeamActivityPanel } from "./TeamActivityPanel";
import { extractTeamOverview } from "./team-activity";

export type AgentSidePanelTab = "team" | "files";

interface AgentSidePanelProps {
  sessionId: string;
  sessionPath: string | null;
  workspaceSlug: string | null;
  teamActivities: ToolActivity[];
  open: boolean;
  activeTab: AgentSidePanelTab;
  onOpenChange: (open: boolean) => void;
  onTabChange: (tab: AgentSidePanelTab) => void;
}

export function AgentSidePanel({
  sessionId,
  sessionPath,
  workspaceSlug,
  teamActivities,
  open,
  activeTab,
  onOpenChange,
  onTabChange
}: AgentSidePanelProps): React.ReactElement | null {
  const teamOverview = React.useMemo(() => extractTeamOverview(teamActivities), [teamActivities]);
  const hasTeamActivity = !!teamOverview;
  const hasFiles = !!sessionPath && !!workspaceSlug;
  const hasContent = hasTeamActivity || hasFiles;

  React.useEffect(() => {
    if (activeTab === "team" && !hasTeamActivity && hasFiles) {
      onTabChange("files");
      return;
    }
    if (activeTab === "files" && !hasFiles && hasTeamActivity) {
      onTabChange("team");
    }
  }, [activeTab, hasFiles, hasTeamActivity, onTabChange]);

  if (!hasContent) return null;

  const runningCount = (teamOverview?.agents ?? []).filter((item) => item.status === "running" || item.status === "backgrounded").length;

  return (
    <div
      className={cn(
        "relative flex-shrink-0 overflow-hidden border-l transition-[width] duration-200",
        open ? "w-[320px]" : "w-10"
      )}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-1.5 top-2 z-20 h-7 w-7"
        onClick={() => onOpenChange(!open)}
        title={open ? "关闭侧面板" : "打开侧面板"}
      >
        <PanelRight className={cn("absolute size-3.5 transition-all", open ? "scale-75 rotate-90 opacity-0" : "scale-100 rotate-0 opacity-100")} />
        <X className={cn("absolute size-3.5 transition-all", open ? "scale-100 rotate-0 opacity-100" : "scale-75 -rotate-90 opacity-0")} />
        {!open && runningCount > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary" />
        ) : null}
      </Button>

      <div
        className={cn(
          "flex h-full w-[320px] flex-col transition-opacity duration-200",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      >
        <div className="flex h-[48px] items-center gap-1 border-b px-2 pr-10">
          <button
            type="button"
            onClick={() => onTabChange("team")}
            disabled={!hasTeamActivity}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs",
              activeTab === "team" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
              !hasTeamActivity && "cursor-not-allowed opacity-50"
            )}
          >
            <Users className="size-3" />
            Team
            {runningCount > 0 ? (
              <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground">{runningCount}</span>
            ) : null}
          </button>

          <button
            type="button"
            onClick={() => onTabChange("files")}
            disabled={!hasFiles}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs",
              activeTab === "files" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
              !hasFiles && "cursor-not-allowed opacity-50"
            )}
          >
            <FolderOpen className="size-3" />
            Files
          </button>
        </div>

        <div className="min-h-0 flex-1">
          {activeTab === "team" ? (
            <TeamActivityPanel activities={teamActivities} />
          ) : hasFiles && workspaceSlug && sessionPath ? (
            <FileBrowser
              workspaceSlug={workspaceSlug}
              sessionId={sessionId}
              rootPath={sessionPath}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">暂无文件目录</div>
          )}
        </div>
      </div>
    </div>
  );
}
