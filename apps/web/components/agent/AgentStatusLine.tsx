import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Agent 状态行：在 Agent 处理请求期间展示当前工作阶段的动态文字描述。
 * 例如 "正在读取文件..."、"正在搜索内容..."、"正在生成回复..."
 */
export function AgentStatusLine({
  text,
  className,
}: {
  text: string;
  className?: string;
}): React.ReactElement {
  return (
    <div
      className={cn(
        "flex items-center gap-2 py-1.5 text-[12px] text-muted-foreground/70",
        "animate-in fade-in duration-300",
        className
      )}
    >
      <Loader2 className="size-3.5 shrink-0 animate-spin text-primary/50" />
      <span className="truncate">{text}</span>
    </div>
  );
}
