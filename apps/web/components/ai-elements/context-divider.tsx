"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ContextDividerProps = React.ComponentProps<"div"> & {
  messageId: string;
  onDelete?: (messageId: string) => void;
};

export function ContextDivider({
  messageId,
  onDelete,
  className,
  ...props
}: ContextDividerProps): React.ReactElement {
  return (
    <div className={cn("relative flex items-center justify-center py-2", className)} {...props}>
      <div className="flex-1 border-t border-dashed border-muted-foreground/30" />
      <div className="mx-3 flex items-center gap-1.5">
        <span className="select-none text-xs text-muted-foreground">清除上下文</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-4 w-4 rounded-full hover:bg-muted"
          onClick={() => onDelete?.(messageId)}
          aria-label="删除分隔线"
        >
          <X className="h-3 w-3 text-muted-foreground" />
        </Button>
      </div>
      <div className="flex-1 border-t border-dashed border-muted-foreground/30" />
    </div>
  );
}
