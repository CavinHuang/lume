"use client";

import { ArrowDownIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes, ReactNode, RefObject } from "react";
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ConversationContextValue = {
  scrollRef: RefObject<HTMLDivElement>;
  isAtBottom: boolean;
  scrollToBottom: () => void;
};

const ConversationContext = createContext<ConversationContextValue | null>(null);

export function useConversationContext(): ConversationContextValue {
  const ctx = useContext(ConversationContext);
  if (!ctx) {
    throw new Error("Conversation subcomponents must be used within <Conversation>");
  }
  return ctx;
}

export interface ConversationProps extends HTMLAttributes<HTMLDivElement> {}

export function Conversation({ className, children, ...props }: ConversationProps): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const updateBottomState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 24;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
    setIsAtBottom(atBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = (): void => {
      updateBottomState();
    };

    updateBottomState();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [updateBottomState]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (isAtBottom) {
      el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
    }
  }, [children, isAtBottom]);

  // 分离滚动按钮和其他内容
  const content = React.Children.toArray(children);
  const scrollButton = content.find(
    (child): child is React.ReactElement => React.isValidElement(child) && child.type === ConversationScrollButton
  );
  const otherChildren = content.filter(
    (child) => !(React.isValidElement(child) && child.type === ConversationScrollButton)
  );

  return (
    <ConversationContext.Provider value={{ scrollRef, isAtBottom, scrollToBottom }}>
      <div className={cn("relative flex-1 overflow-y-hidden", className)} role="log" {...props}>
        <div ref={scrollRef} className="absolute inset-0 overflow-y-auto overscroll-contain">
          {otherChildren}
        </div>
        {scrollButton}
      </div>
    </ConversationContext.Provider>
  );
}

export interface ConversationContentProps extends HTMLAttributes<HTMLDivElement> {}

export function ConversationContent({ className, ...props }: ConversationContentProps): React.ReactElement {
  return <div className={cn("flex flex-col gap-1 p-4", className)} {...props} />;
}

export interface ConversationEmptyStateProps extends ComponentProps<"div"> {
  title?: string;
  description?: string;
  icon?: ReactNode;
}

export function ConversationEmptyState({
  className,
  title = "暂无消息",
  description = "在下方输入框开始对话",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps): React.ReactElement {
  return (
    <div className={cn("flex size-full flex-col items-center justify-center gap-3 p-8 text-center", className)} {...props}>
      {children ?? (
        <>
          {icon ? <div className="text-muted-foreground">{icon}</div> : null}
          <div className="space-y-1">
            <h3 className="text-sm font-medium">{title}</h3>
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
          </div>
        </>
      )}
    </div>
  );
}

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export function ConversationScrollButton({ className, ...props }: ConversationScrollButtonProps): React.ReactElement | null {
  const { isAtBottom, scrollToBottom } = useConversationContext();

  if (isAtBottom) return null;

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className={cn("absolute bottom-8 left-[50%] -translate-x-1/2 rounded-full shadow-md", className)}
      onClick={scrollToBottom}
      {...props}
    >
      <ArrowDownIcon className="size-4" />
    </Button>
  );
}
