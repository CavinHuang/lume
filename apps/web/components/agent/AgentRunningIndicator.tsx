import * as React from "react";
import { Spinner } from "@/components/ui/spinner";

/**
 * 格式化运行时间
 * - 不足一分钟：显示 "1.2s"
 * - 超过一分钟：显示 "1m 2.0s"
 */
function formatTime(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toFixed(1)}s`;
}

interface AgentRunningIndicatorProps {
  /** 运行开始时间戳（Date.now()），用于计算已用时间 */
  startedAt?: number;
}

/**
 * AgentRunningIndicator — 流式输出期间的运行指示器
 *
 * 显示 3x3 网格 Spinner + "Agent Running X.Xs" 计时文字。
 * 对齐 Proma 的 AgentRunningIndicator 实现。
 */
export function AgentRunningIndicator({ startedAt }: AgentRunningIndicatorProps): React.ReactElement {
  const [elapsed, setElapsed] = React.useState(0);

  React.useEffect(() => {
    const start = startedAt ?? Date.now();
    const update = (): void => setElapsed((Date.now() - start) / 1000);
    update();
    const interval = setInterval(update, 100);
    return () => clearInterval(interval);
  }, [startedAt]);

  return (
    <div className="flex items-center gap-2 min-h-[28px]">
      <Spinner size="sm" className="text-primary/50" />
      <span className="text-[13px] font-light text-muted-foreground/50 tabular-nums">
        Agent Running {formatTime(elapsed)}
      </span>
    </div>
  );
}
