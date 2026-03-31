/**
 * ScrollMinimap — 右上角短横杠导航
 *
 * 数据源：messages → MinimapItem[]
 * 依赖 use-stick-to-bottom 的 scrollRef（通过 useConversationContext）
 * 悬浮弹出预览列表，点击跳转
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import { useConversationContext } from "@/components/ai-elements";
import type { AgentMessage } from "@lume/shared";

// ─── Types ───

export interface MinimapItem {
  id: string;
  label: string;
  role: "user" | "assistant";
  /** 对应 DOM 中 data-message-id 的值 */
  messageId: string;
}

interface ScrollMinimapProps {
  messages: AgentMessage[];
  className?: string;
}

// ─── Helpers ───

function buildMinimapItems(messages: AgentMessage[]): MinimapItem[] {
  return messages.map((msg) => {
    const label = msg.role === "user"
      ? (msg.content?.slice(0, 40) || "用户消息")
      : (msg.content?.slice(0, 40) || "助手回复");
    return {
      id: msg.id,
      label: label.length >= 40 ? `${label}…` : label,
      role: msg.role as "user" | "assistant",
      messageId: msg.id,
    };
  });
}

// ─── Component ───

export const ScrollMinimap = React.memo(function ScrollMinimap({
  messages,
  className,
}: ScrollMinimapProps): React.ReactElement | null {
  const { scrollRef } = useConversationContext();
  const [hovered, setHovered] = React.useState(false);
  const [activeId, setActiveId] = React.useState<string | null>(null);

  const items = React.useMemo(() => buildMinimapItems(messages), [messages]);

  // 滚动到指定消息
  const scrollToMessage = React.useCallback((messageId: string) => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    const target = scrollEl.querySelector(`[data-message-id="${messageId}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveId(messageId);
  }, [scrollRef]);

  // 监听滚动更新 activeId
  React.useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl || items.length === 0) return;

    let raf = 0;
    const onScroll = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const containerRect = scrollEl.getBoundingClientRect();
        const midY = containerRect.top + containerRect.height * 0.3;
        let closest: string | null = null;
        let closestDist = Infinity;
        for (const item of items) {
          const el = scrollEl.querySelector(`[data-message-id="${item.messageId}"]`);
          if (!el) continue;
          const rect = el.getBoundingClientRect();
          const dist = Math.abs(rect.top - midY);
          if (dist < closestDist) {
            closestDist = dist;
            closest = item.messageId;
          }
        }
        if (closest) setActiveId(closest);
      });
    };

    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [scrollRef, items]);

  if (items.length < 3) return null;

  return (
    <div
      className={cn("fixed right-3 top-16 z-30 flex flex-col items-end gap-0.5", className)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* 短横杠导航条 */}
      {!hovered ? (
        <div className="flex flex-col gap-[3px] py-1 px-1 rounded-md bg-background/80 backdrop-blur-sm border border-border/30 shadow-sm">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={cn(
                "h-[3px] rounded-full transition-all duration-150",
                item.role === "user" ? "w-3 bg-primary/40" : "w-5 bg-muted-foreground/30",
                activeId === item.messageId && "bg-primary",
              )}
              onClick={() => scrollToMessage(item.messageId)}
            />
          ))}
        </div>
      ) : (
        /* 悬浮预览列表 */
        <div className="max-h-[60vh] w-56 overflow-y-auto rounded-lg border border-border/50 bg-background/95 backdrop-blur-sm shadow-lg py-1">
          {items.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors hover:bg-muted/40",
                activeId === item.messageId && "bg-primary/10 text-primary",
              )}
              onClick={() => scrollToMessage(item.messageId)}
            >
              <span className={cn(
                "size-1.5 shrink-0 rounded-full",
                item.role === "user" ? "bg-primary/60" : "bg-muted-foreground/40",
              )} />
              <span className="truncate text-foreground/70">
                <span className="text-muted-foreground/50 tabular-nums mr-1">{index + 1}.</span>
                {item.label}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
