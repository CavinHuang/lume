/**
 * CollapsibleResult — 可折叠长内容包装器
 *
 * 短内容直接展示，长内容默认折叠，
 * 显示前 N 行 + 字符数/行数统计指示器。
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import {
  CopyResultButton,
  ExpandToggleButton,
  ResultMeta,
} from "./collapsible-result.parts";

interface CollapsibleResultProps {
  content: string;
  threshold?: number;
  previewLines?: number;
  renderContent: (text: string) => React.ReactNode;
  animationDurationMs?: number;
  className?: string;
}

export function CollapsibleResult({
  content,
  threshold = 3000,
  previewLines = 15,
  renderContent,
  animationDurationMs = 200,
  className,
}: CollapsibleResultProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [animatedHeight, setAnimatedHeight] = React.useState<number | "auto">("auto");
  const needsCollapse = content.length > threshold;
  const contentViewportRef = React.useRef<HTMLDivElement>(null);
  const shouldAnimateRef = React.useRef(false);
  const lineCount = React.useMemo(() => content.split("\n").length, [content]);

  const displayContent = React.useMemo(() => {
    if (!needsCollapse || expanded) return content;
    const lines = content.split("\n");
    if (lines.length <= previewLines) return content;
    return lines.slice(0, previewLines).join("\n");
  }, [content, needsCollapse, expanded, previewLines]);

  const handleCopy = React.useCallback(() => {
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  }, [content]);

  const handleToggleExpanded = React.useCallback(() => {
    if (!needsCollapse) {
      setExpanded((prev) => !prev);
      return;
    }
    const viewport = contentViewportRef.current;
    if (viewport) {
      setAnimatedHeight(viewport.offsetHeight);
      shouldAnimateRef.current = true;
    }
    setExpanded((prev) => !prev);
  }, [needsCollapse]);

  React.useLayoutEffect(() => {
    if (!needsCollapse) {
      setAnimatedHeight("auto");
      return;
    }
    if (!shouldAnimateRef.current) return;
    const viewport = contentViewportRef.current;
    if (!viewport) return;
    const nextHeight = viewport.offsetHeight;
    const raf = requestAnimationFrame(() => {
      setAnimatedHeight(nextHeight);
    });
    return () => cancelAnimationFrame(raf);
  }, [displayContent, needsCollapse]);

  return (
    <div className={cn("relative", className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <ResultMeta contentLength={content.length} lineCount={lineCount} />
        <CopyResultButton copied={copied} durationMs={animationDurationMs} onCopy={handleCopy} />
      </div>
      <div
        className={cn(
          "relative overflow-hidden transition-[height,opacity,transform] ease-out",
          needsCollapse && shouldAnimateRef.current && "will-change-[height]",
          expanded ? "opacity-100 translate-y-0" : "opacity-[0.98] -translate-y-[1px]",
          !expanded && needsCollapse && "after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-10 after:bg-gradient-to-t after:from-[#2b3038] after:to-transparent"
        )}
        style={{
          ...(animatedHeight === "auto" ? {} : { height: `${animatedHeight}px` }),
          transitionDuration: `${animationDurationMs}ms`,
        }}
        onTransitionEnd={(event) => {
          if (event.propertyName !== "height") return;
          if (!shouldAnimateRef.current) return;
          shouldAnimateRef.current = false;
          setAnimatedHeight("auto");
        }}
      >
        <div ref={contentViewportRef}>
          {renderContent(displayContent)}
        </div>
      </div>

      {needsCollapse && (
        <ExpandToggleButton
          expanded={expanded}
          contentLength={content.length}
          lineCount={lineCount}
          durationMs={animationDurationMs}
          onToggle={handleToggleExpanded}
        />
      )}
    </div>
  );
}
