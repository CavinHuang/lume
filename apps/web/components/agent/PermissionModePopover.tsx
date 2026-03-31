import { useState } from "react";
import { useAtom } from "jotai";
import { Check, Shield, ShieldCheck, Zap } from "lucide-react";
import type { AgentSendInput } from "@lume/shared";
import { agentPermissionModeAtom } from "@/atoms";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** plan 模式由 useAgentPlanFlow 自动管理，不在用户可选列表中 */
type UserSelectablePermissionMode = Exclude<
  NonNullable<AgentSendInput["permissionMode"]>,
  "plan"
>;

interface PermissionModeOption {
  value: UserSelectablePermissionMode;
  icon: typeof Zap;
  label: string;
  description: string;
  /** 按钮图标颜色 class */
  activeColor: string;
}

const PERMISSION_MODE_OPTIONS: PermissionModeOption[] = [
  {
    value: "bypassPermissions",
    icon: Zap,
    label: "全自动",
    description: "自动执行所有操作，无需确认",
    activeColor: "text-emerald-500",
  },
  {
    value: "acceptEdits",
    icon: ShieldCheck,
    label: "半自动",
    description: "编辑操作自动批准，其他需确认",
    activeColor: "text-amber-500",
  },
  {
    value: "default",
    icon: Shield,
    label: "逐步确认",
    description: "每个工具调用都需要你确认",
    activeColor: "text-foreground/60",
  },
];

/**
 * 权限模式选择器 Popover。
 * 交互模式与思考等级选择器一致：圆形图标按钮 + Popover 弹出列表。
 */
export function PermissionModePopover(): React.ReactElement {
  const [mode, setMode] = useAtom(agentPermissionModeAtom);
  const [open, setOpen] = useState(false);

  // plan 模式由 useAgentPlanFlow 管理，此处回退到 bypassPermissions 展示
  const effectiveMode: UserSelectablePermissionMode =
    mode === "plan" ? "bypassPermissions" : mode;

  const currentOption =
    PERMISSION_MODE_OPTIONS.find((o) => o.value === effectiveMode) ??
    PERMISSION_MODE_OPTIONS[0]!;

  const CurrentIcon = currentOption.icon;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                "size-[30px] rounded-full",
                currentOption.activeColor,
                effectiveMode === "default" && "hover:text-foreground"
              )}
            >
              <CurrentIcon className="size-5" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>权限模式</p>
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        align="start"
        side="top"
        sideOffset={12}
        className="w-auto border-none bg-transparent p-0 shadow-none"
      >
        <div className="w-72 overflow-hidden rounded-md border bg-popover text-popover-foreground">
          {/* 头部 */}
          <div className="border-b p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Shield className="text-muted-foreground size-4" />
                <span className="text-sm font-medium">权限模式</span>
              </div>
              <Badge variant="outline" className="h-5 px-1.5 py-0 text-[10px]">
                {currentOption.label}
              </Badge>
            </div>
            <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
              <Shield className="size-2.5" />
              控制 Agent 执行操作时的确认策略
            </p>
          </div>

          {/* 选项列表 */}
          <ScrollArea className="max-h-[300px]">
            <div className="p-2">
              {PERMISSION_MODE_OPTIONS.map((option) => {
                const checked = option.value === effectiveMode;
                const Icon = option.icon;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => {
                      setMode(option.value);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-start gap-2 rounded px-2 py-1.5 text-left transition-colors",
                      checked
                        ? "bg-primary/10 dark:bg-primary/20"
                        : "hover:bg-muted/50"
                    )}
                  >
                    <div
                      className={cn(
                        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
                        checked
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-input bg-background text-transparent"
                      )}
                    >
                      <Check className="size-3" />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <Icon
                          className={cn(
                            "size-3.5",
                            checked
                              ? option.activeColor
                              : "text-muted-foreground/70"
                          )}
                        />
                        <span className="truncate text-sm font-medium">
                          {option.label}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {option.description}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </ScrollArea>
        </div>
      </PopoverContent>
    </Popover>
  );
}
