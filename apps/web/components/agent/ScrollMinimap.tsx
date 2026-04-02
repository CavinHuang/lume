/**
 * ScrollMinimap — 右侧短横杠导航
 *
 * 数据源：messages → MinimapItem[]
 * 依赖 use-stick-to-bottom 的 scrollRef（通过 useConversationContext）
 * 极简短横杠导航，支持上下切换与悬浮预览
 */
import * as React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentMessage } from "@lume/shared";

// ─── Types ───

export interface MinimapItem {
  id: string;
  label: string;
  preview: string;
  role: "user" | "assistant";
  /** 对应 DOM 中 data-message-id 的值 */
  messageId: string;
}

interface ScrollMinimapProps {
  messages: AgentMessage[];
  className?: string;
  scrollElement: HTMLElement | null;
  style?: React.CSSProperties;
}

// ─── Helpers ───

function computeIdleWidth(label: string): number {
  const base = 4.8;
  const extra = Math.min(4.2, Math.max(0, label.length - 8) * 0.18);
  return Number((base + extra).toFixed(2));
}

export function buildMinimapItems(messages: AgentMessage[]): MinimapItem[] {
  return messages
    .filter((msg): msg is AgentMessage & { role: "user" | "assistant" } => msg.role === "user" || msg.role === "assistant")
    .map((msg) => {
      const raw = (msg.content ?? "").replace(/\s+/g, " ").trim();
      const labelBase = msg.role === "user"
        ? (raw.slice(0, 40) || "用户消息")
        : (raw.slice(0, 40) || "助手回复");
      const previewBase = msg.role === "user"
        ? (raw.slice(0, 120) || "用户消息")
        : (raw.slice(0, 120) || "助手回复");
      return {
        id: msg.id,
        label: labelBase.length >= 40 ? `${labelBase}…` : labelBase,
        preview: previewBase.length >= 120 ? `${previewBase}…` : previewBase,
        role: msg.role,
        messageId: msg.id,
      };
    });
}

// ─── Component ───

export const ScrollMinimap = React.memo(function ScrollMinimap({
  messages,
  className,
  scrollElement,
  style,
}: ScrollMinimapProps): React.ReactElement | null {
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);

  const items = React.useMemo(() => buildMinimapItems(messages), [messages]);

  // 滚动到指定消息
  const scrollToMessage = React.useCallback((messageId: string) => {
    const scrollEl = scrollElement;
    if (!scrollEl) return;
    const target = scrollEl.querySelector(`[data-message-id="${messageId}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveId(messageId);
  }, [scrollElement]);

  // 监听滚动更新 activeId
  React.useEffect(() => {
    const scrollEl = scrollElement;
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
  }, [scrollElement, items]);

  if (items.length < 3) return null;

  const railHeight = items.length * 4 + 4;
  const verticalOffset = Number((railHeight / 2 + 63.9375).toFixed(4));
  const activeIndex = Math.max(0, items.findIndex((item) => item.messageId === activeId));
  const previewId = hoveredId;
  const previewItem = previewId ? items.find((item) => item.messageId === previewId) ?? null : null;
  const previewIndex = previewItem ? items.findIndex((item) => item.id === previewItem.id) : -1;

  const moveActive = React.useCallback((delta: -1 | 1) => {
    if (items.length === 0) return;
    const baseIndex = activeIndex >= 0 ? activeIndex : 0;
    const nextIndex = Math.max(0, Math.min(items.length - 1, baseIndex + delta));
    const nextItem = items[nextIndex];
    if (!nextItem) return;
    scrollToMessage(nextItem.messageId);
  }, [activeIndex, items, scrollToMessage]);

  return (
    <div
      className={cn("flex flex-col items-end absolute right-3 -translate-y-1/2", className)}
      style={{ top: `calc(50% - ${verticalOffset}px)`, ...style }}
    >
      <div className="flex h-5 items-center justify-end">
        <button
          type="button"
          className="pointer-events-auto text-muted-foreground/60 hover:text-muted-foreground disabled:opacity-30 disabled:cursor-default"
          onClick={() => moveActive(-1)}
          disabled={activeIndex <= 0}
          aria-label="上一条"
        >
          <ChevronUp className="w-4 h-4 -mr-1" />
        </button>
      </div>
      <div className="relative w-6" style={{ height: `${railHeight}px` }}>
        {items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            className="absolute left-0 right-0 h-4 flex items-center justify-end"
            style={{
              top: `${4 + index * 4}px`,
              transform: "translateY(-50%)"
            }}
            onClick={() => scrollToMessage(item.messageId)}
            onMouseEnter={() => setHoveredId(item.messageId)}
            onMouseLeave={() => setHoveredId((current) => (current === item.messageId ? null : current))}
            onFocus={() => setHoveredId(item.messageId)}
            onBlur={() => setHoveredId((current) => (current === item.messageId ? null : current))}
            aria-label={item.label}
            title={item.label}
          >
              <div
                className={cn(
                  "h-[1.5px] transition-all duration-200 ease-out",
                  activeId === item.messageId || hoveredId === item.messageId
                    ? "bg-foreground/70"
                  : "bg-muted-foreground/40"
              )}
              style={{
                width: `${activeId === item.messageId ? 20 : hoveredId === item.messageId ? Math.min(14, computeIdleWidth(item.label) + 3.2) : computeIdleWidth(item.label)}px`
              }}
            />
          </button>
        ))}
        {previewItem && previewIndex >= 0 ? (
          <div
            className="absolute right-full mr-1 flex items-center pointer-events-none"
            style={{
              top: `${4 + previewIndex * 4}px`,
              transform: "translateY(-50%)"
            }}
          >
            <div className="bg-muted dark:bg-zinc-700 rounded-2xl px-3 py-2 shadow-md max-w-[160px]">
              <p className="text-sm text-foreground leading-snug line-clamp-2">{previewItem.preview}</p>
            </div>
            <div className="w-0 h-0 border-t-[5px] border-t-transparent border-b-[5px] border-b-transparent border-l-[5px] border-l-muted dark:border-l-zinc-700 shrink-0" />
          </div>
        ) : null}
      </div>
      <div className="flex h-5 items-center justify-end">
        <button
          type="button"
          className="pointer-events-auto text-muted-foreground/60 hover:text-muted-foreground disabled:opacity-30 disabled:cursor-default"
          onClick={() => moveActive(1)}
          disabled={activeIndex >= items.length - 1}
          aria-label="下一条"
        >
          <ChevronDown className="w-4 h-4 -mr-1" />
        </button>
      </div>
    </div>
  );
});
