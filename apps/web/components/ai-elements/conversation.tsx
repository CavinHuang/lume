import { ArrowDownIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes, ReactNode } from "react";
import React, { useCallback } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function useConversationContext() {
  return useStickToBottomContext();
}

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export function Conversation({ className, ...props }: ConversationProps): React.ReactElement {
  return (
    <StickToBottom
      className={cn("relative flex-1 overflow-y-hidden", className)}
      initial="instant"
      resize="smooth"
      role="log"
      {...props}
    />
  );
}

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;

export function ConversationContent({ className, ...props }: ConversationContentProps): React.ReactElement {
  return <StickToBottom.Content className={cn("flex flex-col gap-1 p-4", className)} {...props} />;
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

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  if (isAtBottom) return null;

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className={cn("absolute bottom-8 left-[50%] -translate-x-1/2 rounded-full shadow-md", className)}
      onClick={handleScrollToBottom}
      {...props}
    >
      <ArrowDownIcon className="size-4" />
    </Button>
  );
}
