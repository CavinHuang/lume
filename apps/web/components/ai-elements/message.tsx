"use client";

import * as React from "react";
import { Streamdown } from "streamdown";
import { ChevronDown, ChevronUp, Paperclip } from "lucide-react";
import { CodeBlock, MermaidBlock } from "@lume/ui";
import type { FileAttachment } from "@lume/shared";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { openExternalUrl, readChatAttachment } from "@/lib/desktop-api";

type MessageRole = "user" | "assistant" | "system";

interface MessageProps extends React.HTMLAttributes<HTMLDivElement> {
  from: MessageRole;
}

export function Message({ className, from, ...props }: MessageProps): React.ReactElement {
  return (
    <div
      className={cn(
        "group flex w-full flex-col gap-0.5 rounded-[10px] px-2.5 py-2.5 transition-colors duration-300",
        from === "user" ? "is-user" : "is-assistant",
        className
      )}
      {...props}
    />
  );
}

interface MessageHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  model?: string;
  logo?: React.ReactNode;
  time?: string;
}

export function MessageHeader({ model, logo, time, className, children, ...props }: MessageHeaderProps): React.ReactElement {
  return (
    <div className={cn("mb-2.5 flex items-start gap-2.5 group-[.is-user]:hidden", className)} {...props}>
      {logo ? (
        <div className="flex size-[35px] shrink-0 items-center justify-center overflow-hidden rounded-[25%]">
          {logo}
        </div>
      ) : null}
      <div className="flex h-[35px] flex-col justify-between">
        {model ? <span className="text-sm font-semibold leading-none text-foreground/60">{model}</span> : null}
        {time ? <span className="text-[10px] leading-none text-foreground/[0.38]">{time}</span> : null}
      </div>
      {children}
    </div>
  );
}

export function MessageContent({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      className={cn(
        "flex w-full min-w-0 max-w-full flex-col gap-2 overflow-hidden pl-[46px]",
        "group-[.is-user]:text-foreground group-[.is-assistant]:text-foreground",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function MessageActions({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 opacity-0 transition-opacity duration-200 group-hover:opacity-100",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

interface MessageActionProps extends React.ComponentProps<typeof Button> {
  tooltip?: string;
  label?: string;
}

export function MessageAction({
  tooltip,
  label,
  variant = "ghost",
  size = "icon-sm",
  children,
  ...props
}: MessageActionProps): React.ReactElement {
  const button = (
    <Button type="button" variant={variant} size={size} {...props}>
      {children}
      <span className="sr-only">{label ?? tooltip}</span>
    </Button>
  );

  if (!tooltip) return button;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent>
          <p>{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

interface MessageResponseProps {
  children: string;
  className?: string;
}

export const MessageResponse = React.memo(
  function MessageResponse({ children, className }: MessageResponseProps): React.ReactElement {
    return (
      <div
        className={cn(
          "prose dark:prose-invert max-w-none text-[14px]",
          "prose-p:my-1.5 prose-p:leading-[1.6] prose-li:leading-[1.6] prose-pre:my-0 prose-headings:my-2",
          "[&_.code-block-wrapper+.code-block-wrapper]:mt-4 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          className
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
            ),
            pre: ({ children: preChildren }) => {
              const codeChild = React.Children.toArray(preChildren).find(
                (child): child is React.ReactElement => React.isValidElement(child) && child.type === "code"
              );

              if (codeChild) {
                const codeProps = codeChild.props as { className?: string; children?: React.ReactNode };
                if (codeProps.className?.includes("language-mermaid")) {
                  const extractText = (node: React.ReactNode): string => {
                    if (typeof node === "string") return node;
                    if (typeof node === "number") return String(node);
                    if (!node) return "";
                    if (Array.isArray(node)) return node.map(extractText).join("");
                    if (React.isValidElement(node)) {
                      return extractText((node.props as { children?: React.ReactNode }).children);
                    }
                    return "";
                  };
                  const mermaidCode = extractText(codeProps.children).replace(/\n$/, "");
                  return <MermaidBlock code={mermaidCode} />;
                }
              }

              return <CodeBlock>{preChildren}</CodeBlock>;
            }
          }}
        >
          {children}
        </Streamdown>
      </div>
    );
  },
  (prev, next) => prev.children === next.children
);

export function AIMessage({ content }: { content: string }): React.ReactElement {
  return <MessageResponse>{content}</MessageResponse>;
}

const COLLAPSE_LINE_THRESHOLD = 4;

interface UserMessageContentProps extends React.HTMLAttributes<HTMLDivElement> {
  children: string;
}

export const UserMessageContent = React.memo(
  function UserMessageContent({ children, className, ...props }: UserMessageContentProps): React.ReactElement {
    const [isExpanded, setIsExpanded] = React.useState(false);
    const [shouldCollapse, setShouldCollapse] = React.useState(false);
    const contentRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
      if (!contentRef.current) return;
      const element = contentRef.current;
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      const maxHeight = lineHeight * COLLAPSE_LINE_THRESHOLD;
      setShouldCollapse(element.scrollHeight > maxHeight + 10);
    }, [children]);

    return (
      <div className={cn("relative rounded-[10px] bg-foreground/[0.045] px-3.5 py-2.5 dark:bg-foreground/[0.08]", className)} {...props}>
        <div
          ref={contentRef}
          className={cn(
            "overflow-hidden whitespace-pre-wrap text-[14px] leading-[1.6] transition-[max-height] duration-200",
            "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
            shouldCollapse && !isExpanded ? "max-h-[6.5em]" : ""
          )}
        >
          {children}
        </div>
        {shouldCollapse ? (
          <button
            type="button"
            onClick={() => setIsExpanded((prev) => !prev)}
            className={cn(
              "mt-1 flex items-center gap-1 text-xs text-foreground/40 transition-colors hover:text-foreground/70",
              !isExpanded
                ? "absolute bottom-0 left-0 right-0 bg-gradient-to-t from-foreground/[0.045] to-transparent pt-4 dark:from-foreground/[0.08]"
                : ""
            )}
          >
            {isExpanded ? (
              <>
                <ChevronUp className="size-3" />
                <span>收起</span>
              </>
            ) : (
              <>
                <ChevronDown className="size-3" />
                <span>展开全部</span>
              </>
            )}
          </button>
        ) : null}
      </div>
    );
  },
  (prev, next) => prev.children === next.children
);

export function MessageLoading({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div className={cn("mt-2 flex items-center gap-1", className)} {...props}>
      <span className="size-2 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.3s]" />
      <span className="size-2 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.15s]" />
      <span className="size-2 animate-bounce rounded-full bg-muted-foreground/60" />
    </div>
  );
}

export function MessageStopped({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div className={cn("mt-2 flex items-center gap-1.5 text-sm text-muted-foreground", className)} {...props}>
      <span className="size-2 rounded-full bg-muted-foreground/40" />
      <span>已停止生成</span>
    </div>
  );
}

interface MessageAttachmentsProps extends React.HTMLAttributes<HTMLDivElement> {
  attachments: FileAttachment[];
}

export function MessageAttachments({ attachments, className, ...props }: MessageAttachmentsProps): React.ReactElement {
  const imageAttachments = attachments.filter((att) => att.mediaType.startsWith("image/"));
  const fileAttachments = attachments.filter((att) => !att.mediaType.startsWith("image/"));
  const isSingleImage = imageAttachments.length === 1 && fileAttachments.length === 0;

  return (
    <div className={cn("mb-2 flex flex-col gap-2", className)} {...props}>
      {imageAttachments.length > 0 ? (
        <div className="flex flex-wrap gap-2.5">
          {imageAttachments.map((att) => (
            <MessageAttachmentImage key={att.id} attachment={att} isSingle={isSingleImage} />
          ))}
        </div>
      ) : null}
      {fileAttachments.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {fileAttachments.map((att) => (
            <MessageAttachmentFile key={att.id} attachment={att} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MessageAttachmentImage({
  attachment,
  isSingle
}: {
  attachment: FileAttachment;
  isSingle: boolean;
}): React.ReactElement {
  const [imageSrc, setImageSrc] = React.useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void readChatAttachment(attachment.localPath)
      .then((base64) => {
        if (cancelled) return;
        setImageSrc(`data:${attachment.mediaType};base64,${base64}`);
      })
      .catch((error) => {
        console.error("[MessageAttachmentImage] read attachment failed:", error);
      });

    return () => {
      cancelled = true;
    };
  }, [attachment.localPath, attachment.mediaType]);

  if (!imageSrc) {
    return (
      <div
        className={cn(
          "shrink-0 animate-pulse rounded-lg bg-muted/30",
          isSingle ? "h-[200px] w-[280px]" : "size-[280px]"
        )}
      />
    );
  }

  return isSingle ? (
    <>
      <button
        type="button"
        className="rounded-lg"
        onClick={() => setPreviewOpen(true)}
      >
        <img
          src={imageSrc}
          alt={attachment.filename}
          className="max-h-[min(500px,50vh)] max-w-[500px] rounded-lg object-contain"
        />
      </button>
      {previewOpen ? (
        <button
          type="button"
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
          onClick={() => setPreviewOpen(false)}
        >
          <img src={imageSrc} alt={attachment.filename} className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain" />
        </button>
      ) : null}
    </>
  ) : (
    <>
      <button
        type="button"
        className="rounded-lg"
        onClick={() => setPreviewOpen(true)}
      >
        <img src={imageSrc} alt={attachment.filename} className="size-[280px] shrink-0 rounded-lg object-cover" />
      </button>
      {previewOpen ? (
        <button
          type="button"
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
          onClick={() => setPreviewOpen(false)}
        >
          <img src={imageSrc} alt={attachment.filename} className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain" />
        </button>
      ) : null}
    </>
  );
}

function MessageAttachmentFile({ attachment }: { attachment: FileAttachment }): React.ReactElement {
  const displayName = attachment.filename.length > 20 ? `${attachment.filename.slice(0, 17)}...` : attachment.filename;
  const handleOpen = (): void => {
    void readChatAttachment(attachment.localPath)
      .then((base64) => {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: attachment.mediaType || "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank", "noopener,noreferrer");
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      })
      .catch((error) => {
        console.error("[MessageAttachmentFile] read attachment failed:", error);
      });
  };

  return (
    <button
      type="button"
      onClick={handleOpen}
      className="flex shrink-0 items-center gap-2 rounded-lg border border-[#37a5aa]/20 bg-[#37a5aa]/10 px-3 py-1.5 text-[13px] text-[#37a5aa] transition-colors hover:bg-[#37a5aa]/15"
    >
      <Paperclip className="size-4" />
      <span>{displayName}</span>
    </button>
  );
}

export function StreamingIndicator({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>): React.ReactElement {
  return (
    <span
      className={cn("ml-1 inline-block size-2 animate-pulse rounded-full bg-primary/60 align-middle", className)}
      {...props}
    />
  );
}
