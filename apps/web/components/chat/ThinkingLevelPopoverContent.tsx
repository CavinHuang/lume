"use client";

import { Check, CircleOff, Lightbulb, WandSparkles } from "lucide-react";
import type { ThinkingLevel } from "@lume/shared";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { ThinkingLevelOption } from "./thinking-level";

interface ThinkingLevelPopoverContentProps {
  value: ThinkingLevel;
  options: ThinkingLevelOption[];
  onSelect: (value: ThinkingLevel) => void;
}

export function ThinkingLevelPopoverContent({
  value,
  options,
  onSelect
}: ThinkingLevelPopoverContentProps): React.ReactElement {
  const currentOption = options.find((option) => option.value === value) ?? options[0]!;

  return (
    <div className="w-72 overflow-hidden rounded-md border bg-popover text-popover-foreground">
      <div className="border-b p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <WandSparkles className="text-muted-foreground size-4" />
            <span className="text-sm font-medium">推理</span>
          </div>
          <Badge variant="outline" className="h-5 px-1.5 py-0 text-[10px]">
            {currentOption.label}
          </Badge>
        </div>
        <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
          <WandSparkles className="size-2.5" />
          调整支持扩展思考的模型的推理强度
        </p>
      </div>

      <ScrollArea className="max-h-[300px]">
        <div className="p-2">
          {options.map((option) => {
            const checked = option.value === value;
            const Icon = option.value === "off" ? CircleOff : Lightbulb;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => onSelect(option.value)}
                className={cn(
                  "flex w-full items-start gap-2 rounded px-2 py-1.5 text-left transition-colors",
                  checked ? "bg-primary/10 dark:bg-primary/20" : "hover:bg-muted/50"
                )}
              >
                <div className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
                  checked
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input bg-background text-transparent"
                )}>
                  <Check className="size-3" />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <Icon className="size-3.5 text-muted-foreground/70" />
                    <span className="truncate text-sm font-medium">{option.label}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{option.description}</p>
                </div>
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
