import type * as React from "react";
import { Plug, Settings, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

interface CapabilityCounts {
  mcp: number;
  skills: number;
}

interface SidebarSettingsEntryProps {
  active: boolean;
  hasUpdate: boolean;
  capabilities: CapabilityCounts | null;
  showCapabilities: boolean;
  onOpenSettings: () => void;
}

export function SidebarSettingsEntry({
  active,
  hasUpdate,
  capabilities,
  showCapabilities,
  onOpenSettings,
}: SidebarSettingsEntryProps): React.ReactElement {
  return (
    <>
      {showCapabilities && capabilities ? (
        <div className="px-3 pb-1">
          <button
            type="button"
            className="titlebar-no-drag flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-[12px] text-foreground/50 transition-colors hover:bg-foreground/[0.04] hover:text-foreground/70"
            onClick={onOpenSettings}
          >
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <span className="inline-flex items-center gap-1">
                <Plug size={13} className="text-foreground/40" />
                <span className="tabular-nums">{capabilities.mcp}</span>
                <span className="text-foreground/30">MCP</span>
              </span>
              <span className="text-foreground/20">·</span>
              <span className="inline-flex items-center gap-1">
                <Zap size={13} className="text-foreground/40" />
                <span className="tabular-nums">{capabilities.skills}</span>
                <span className="text-foreground/30">Skills</span>
              </span>
            </div>
          </button>
        </div>
      ) : null}

      <div className="px-3 pb-3">
        <button
          type="button"
          className={cn(
            "titlebar-no-drag flex w-full items-center justify-between rounded-[10px] px-3 py-2 text-left text-[13px] transition-colors",
            active
              ? "bg-foreground/[0.08] text-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]"
              : "text-foreground/60 hover:bg-foreground/[0.04] hover:text-foreground",
          )}
          onClick={onOpenSettings}
        >
          <span className="inline-flex items-center gap-3">
            <span className="inline-flex h-[18px] w-[18px] items-center justify-center">
              <Settings size={18} />
            </span>
            <span>设置</span>
          </span>
          {hasUpdate ? <span className="h-2 w-2 rounded-full bg-red-500" /> : null}
        </button>
      </div>
    </>
  );
}
