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

const AUTO_CLOSE_DELAY = 2200;
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
  const wasStreamingRef = React.useRef(isStreaming);

  React.useEffect(() => {
    if (isStreaming) {
      if (startTime === null) {
        setStartTime(Date.now());
      }
      setHasAutoClosed(false);
      if (!isOpen) {
        setIsOpen(true);
      }
    } else if (startTime !== null) {
      setDuration(Math.ceil((Date.now() - startTime) / MS_IN_S));
      setStartTime(null);
    }
  }, [isOpen, isStreaming, setIsOpen, startTime]);

  React.useEffect(() => {
    wasStreamingRef.current = isStreaming;
    const hasFinishedThinking = durationProp !== undefined || duration !== undefined || startTime === null;
    if (defaultOpen && !isStreaming && isOpen && !hasAutoClosed && hasFinishedThinking) {
      const timer = setTimeout(() => {
        setIsOpen(false);
        setHasAutoClosed(true);
      }, AUTO_CLOSE_DELAY);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [defaultOpen, duration, durationProp, hasAutoClosed, isOpen, isStreaming, setIsOpen, startTime]);

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
    return <span>思考中... {elapsedSeconds ?? 0}s</span>;
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
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-gray-400 transition-all duration-200 hover:bg-muted/25 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300",
        isStreaming && "reasoning-stream-shell pr-3",
        className
      )}
      {...props}
    >
      {children ?? (
        <>
          <Brain className="size-4" />
          <span className="text-[12px] font-medium tracking-[0.01em]">
            {getThinkingMessage(isStreaming, duration, elapsedSeconds)}
          </span>
          <ChevronDown className={cn("size-4 transition-transform duration-200 ease-out", isOpen ? "rotate-180" : "rotate-0")} />
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
          "mt-3 overflow-hidden text-sm text-gray-400 dark:text-gray-500 outline-none",
          "data-[state=closed]:animate-out data-[state=open]:animate-in",
          "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          "data-[state=closed]:slide-out-to-top-1 data-[state=open]:slide-in-from-top-1",
          "data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down",
          className
        )}
        {...props}
      >
        <div
          className={cn(
            "rounded-lg border border-white/6 bg-white/[0.02] px-3 py-2.5",
            "prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
            "prose-p:my-1 prose-p:text-[12px] prose-p:leading-[1.65]",
            "prose-li:text-[12px] prose-li:leading-[1.65] prose-code:text-[11px]",
            "prose-p:text-gray-500 prose-li:text-gray-500 prose-strong:text-gray-500 prose-code:text-gray-500 prose-headings:text-gray-500 prose-a:text-gray-500 hover:prose-a:text-gray-600",
            "dark:prose-p:text-gray-500/90 dark:prose-li:text-gray-500/90 dark:prose-strong:text-gray-500/90 dark:prose-code:text-gray-500/90 dark:prose-headings:text-gray-500/90 dark:prose-a:text-gray-400 dark:hover:prose-a:text-gray-300"
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
