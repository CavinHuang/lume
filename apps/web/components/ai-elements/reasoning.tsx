import * as React from "react";
import { Brain, ChevronDown } from "lucide-react";
import { Streamdown } from "streamdown";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { openExternalUrl } from "@/lib/desktop-api/core";
import { cn } from "@/lib/utils";

type ReasoningContextValue = {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
  elapsedSeconds: number;
};

const ReasoningContext = React.createContext<ReasoningContextValue | null>(null);

function useReasoning(): ReasoningContextValue {
  const ctx = React.useContext(ReasoningContext);
  if (!ctx) {
    throw new Error("Reasoning children must be used inside <Reasoning>");
  }
  return ctx;
}

const AUTO_CLOSE_DELAY = 1000;
const MS_IN_S = 1000;

interface ReasoningProps extends React.ComponentProps<typeof Collapsible> {
  isStreaming?: boolean;
  duration?: number;
}

export const Reasoning = React.memo(function Reasoning({
  className,
  isStreaming = false,
  open: openProp,
  defaultOpen = true,
  onOpenChange,
  duration: durationProp,
  children,
  ...props
}: ReasoningProps): React.ReactElement {
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const isOpen = openProp !== undefined ? openProp : internalOpen;

  const setIsOpen = React.useCallback(
    (nextOpen: boolean) => {
      setInternalOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [onOpenChange]
  );

  const [duration, setDuration] = React.useState<number | undefined>(durationProp);
  const [hasAutoClosed, setHasAutoClosed] = React.useState(false);
  const [startTime, setStartTime] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (isStreaming) {
      if (startTime === null) {
        setStartTime(Date.now());
      }
    } else if (startTime !== null) {
      setDuration(Math.ceil((Date.now() - startTime) / MS_IN_S));
      setStartTime(null);
    }
  }, [isStreaming, startTime]);

  React.useEffect(() => {
    if (defaultOpen && !isStreaming && isOpen && !hasAutoClosed) {
      const timer = setTimeout(() => {
        setIsOpen(false);
        setHasAutoClosed(true);
      }, AUTO_CLOSE_DELAY);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [defaultOpen, hasAutoClosed, isOpen, isStreaming, setIsOpen]);

  React.useEffect(() => {
    if (durationProp !== undefined) {
      setDuration(durationProp);
    }
  }, [durationProp]);

  // 实时计时：streaming 时每秒更新 elapsed
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
  React.useEffect(() => {
    if (!isStreaming) {
      setElapsedSeconds(0);
      return;
    }
    const t0 = Date.now();
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - t0) / MS_IN_S));
    }, MS_IN_S);
    return () => clearInterval(timer);
  }, [isStreaming]);

  return (
    <ReasoningContext.Provider value={{ isStreaming, isOpen, setIsOpen, duration, elapsedSeconds }}>
      <Collapsible className={cn("not-prose mb-4", className)} open={isOpen} onOpenChange={setIsOpen} {...props}>
        {children}
      </Collapsible>
    </ReasoningContext.Provider>
  );
});

interface ReasoningTriggerProps extends React.ComponentProps<typeof CollapsibleTrigger> {
  getThinkingMessage?: (isStreaming: boolean, duration?: number, elapsedSeconds?: number) => React.ReactNode;
}

function defaultThinkingMessage(isStreaming: boolean, duration?: number, elapsedSeconds?: number): React.ReactNode {
  if (isStreaming) {
    // 实时计时：思考中... 1s / 2s / ...
    if (elapsedSeconds && elapsedSeconds > 0) {
      return <span>思考中... {elapsedSeconds}s</span>;
    }
    return <span className="animate-pulse">思考中...</span>;
  }
  if (duration !== undefined && duration > 0) {
    return <p>思考了 {duration} 秒</p>;
  }
  return <p>思考过程</p>;
}

export const ReasoningTrigger = React.memo(function ReasoningTrigger({
  className,
  children,
  getThinkingMessage = defaultThinkingMessage,
  ...props
}: ReasoningTriggerProps): React.ReactElement {
  const { isStreaming, isOpen, duration, elapsedSeconds } = useReasoning();

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center gap-2 text-sm text-gray-400 transition-colors hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300",
        className
      )}
      {...props}
    >
      {children ?? (
        <>
          <Brain className="size-4" />
          {getThinkingMessage(isStreaming, duration, elapsedSeconds)}
          <ChevronDown className={cn("size-4 transition-transform", isOpen ? "rotate-180" : "rotate-0")} />
        </>
      )}
    </CollapsibleTrigger>
  );
});

interface ReasoningContentProps extends React.ComponentProps<typeof CollapsibleContent> {
  children: string;
}

export const ReasoningContent = React.memo(
  function ReasoningContent({ className, children, ...props }: ReasoningContentProps): React.ReactElement {
    return (
      <CollapsibleContent
        className={cn(
          "mt-4 text-sm text-gray-400 dark:text-gray-500 outline-none",
          "data-[state=closed]:animate-out data-[state=open]:animate-in",
          "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          "data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2",
          className
        )}
        {...props}
      >
        <div
          className={cn(
            "prose prose-sm dark:prose-invert max-w-none prose-p:my-1 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
            "prose-p:text-gray-400 prose-li:text-gray-400 prose-strong:text-gray-400 prose-code:text-gray-400 prose-headings:text-gray-400 prose-a:text-gray-500 hover:prose-a:text-gray-600",
            "dark:prose-p:text-gray-500 dark:prose-li:text-gray-500 dark:prose-strong:text-gray-500 dark:prose-code:text-gray-500 dark:prose-headings:text-gray-500 dark:prose-a:text-gray-400 dark:hover:prose-a:text-gray-300"
          )}
        >
          <Streamdown
            parseIncompleteMarkdown
            mode="streaming"
            components={{
              a: ({ href, children: linkChildren, ...linkProps }) => (
                <a
                  {...linkProps}
                  href={href}
                  onClick={(event) => {
                    event.preventDefault();
                    if (!href) return;
                    if (href.startsWith("http://") || href.startsWith("https://")) {
                      void openExternalUrl(href);
                    }
                  }}
                  title={href}
                >
                  {linkChildren}
                </a>
              )
            }}
          >
            {children}
          </Streamdown>
        </div>
      </CollapsibleContent>
    );
  },
  (prev, next) => prev.children === next.children
);

export function ReasoningBlock({ content }: { content: string }): React.ReactElement {
  return (
    <Reasoning isStreaming={false} defaultOpen>
      <ReasoningTrigger />
      <ReasoningContent>{content}</ReasoningContent>
    </Reasoning>
  );
}
