import * as React from "react";
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
      <span className="flex items-center gap-1.5">
        <span className="statusline-dot size-1.5 rounded-full bg-primary/60" />
        <span className="statusline-dot size-1.5 rounded-full bg-primary/45" />
        <span className="statusline-dot size-1.5 rounded-full bg-primary/35" />
      </span>
      <span className="truncate">{text}</span>
    </div>
  );
}
