"use client";

import { useEffect, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Brain, Globe, Settings, Sparkles, Wrench } from "lucide-react";
import { activeViewAtom, chatToolsAtom, hasActiveToolsAtom, settingsTabAtom } from "@/atoms";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getChatTools, updateChatToolState } from "@/lib/desktop-api";
import { cn } from "@/lib/utils";

function getToolIcon(iconName?: string): React.ReactElement {
  if (iconName === "Brain") return <Brain className="size-4" />;
  if (iconName === "Globe") return <Globe className="size-4" />;
  if (iconName === "Sparkles") return <Sparkles className="size-4" />;
  return <Wrench className="size-4" />;
}

export function ToolSelectorPopover(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useAtom(chatToolsAtom);
  const hasActiveTools = useAtomValue(hasActiveToolsAtom);
  const setActiveView = useSetAtom(activeViewAtom);
  const setSettingsTab = useSetAtom(settingsTabAtom);

  const refreshTools = async (): Promise<void> => {
    const next = await getChatTools();
    setTools(next);
  };

  useEffect(() => {
    void refreshTools().catch((error) => {
      console.error("[ToolSelectorPopover] 加载工具失败:", error);
    });
  }, []);

  const toggleTool = async (toolId: string, currentEnabled: boolean): Promise<void> => {
    try {
      await updateChatToolState(toolId, { enabled: !currentEnabled });
      await refreshTools();
    } catch (error) {
      console.error("[ToolSelectorPopover] 切换工具失败:", error);
    }
  };

  const goToToolSettings = (): void => {
    setOpen(false);
    setActiveView("settings");
    setSettingsTab("tools");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip open={open ? false : undefined}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                "size-[30px] rounded-full",
                hasActiveTools ? "text-blue-500" : "text-foreground/60 hover:text-foreground"
              )}
            >
              <Wrench className="size-5" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>工具</p>
        </TooltipContent>
      </Tooltip>

      <PopoverContent className="w-64" side="top" align="center">
        <div className="space-y-2">
          <div className="text-xs font-medium">工具</div>
          {tools.length === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">加载中...</p>
          ) : (
            <div className="space-y-1">
              {tools.map((tool) => (
                <div
                  key={tool.meta.id}
                  className="flex items-center justify-between rounded-md px-1 py-1.5 hover:bg-muted/50"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={cn("shrink-0", !tool.available && "opacity-40")}>
                        {getToolIcon(tool.meta.icon)}
                      </span>
                      <span className={cn("truncate text-sm", !tool.available && "text-muted-foreground")}>
                        {tool.meta.name}
                      </span>
                      {!tool.available ? (
                        <span className="shrink-0 text-[10px] text-muted-foreground">需配置</span>
                      ) : null}
                    </div>
                    <p className="truncate text-[11px] text-muted-foreground">{tool.meta.description}</p>
                  </div>
                  <Switch
                    checked={tool.enabled && tool.available}
                    onCheckedChange={() => {
                      void toggleTool(tool.meta.id, tool.enabled);
                    }}
                    disabled={!tool.available}
                    className="scale-75"
                  />
                </div>
              ))}
            </div>
          )}

          <button
            type="button"
            className="flex w-full items-center gap-1.5 border-t border-border/50 pt-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            onClick={goToToolSettings}
          >
            <Settings className="size-3" />
            <span>管理工具</span>
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
