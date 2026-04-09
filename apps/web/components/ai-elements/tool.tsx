import * as React from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { ComponentProps, ReactNode } from "react";

export type ToolProps = ComponentProps<typeof Collapsible>;

export function Tool({ className, ...props }: ToolProps): React.ReactElement {
  return (
    <Collapsible
      className={cn(
        "group/tool w-full rounded-xl border border-white/10 bg-[#2b3038]/85 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]",
        "transition-[border-color,background-color,box-shadow,transform] duration-200 ease-out",
        "data-[state=open]:border-white/15 data-[state=open]:bg-[#313740]/90 data-[state=open]:shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_8px_24px_rgba(0,0,0,0.18)]",
        className
      )}
      {...props}
    />
  );
}

export interface ToolHeaderProps extends ComponentProps<typeof CollapsibleTrigger> {
  icon?: ReactNode;
  summary: ReactNode;
  meta?: ReactNode;
  status?: ReactNode;
  trailing?: ReactNode;
}

export function ToolHeader({
  className,
  icon,
  summary,
  meta,
  status,
  trailing,
  children,
  ...props
}: ToolHeaderProps): React.ReactElement {
  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center gap-2 px-3.5 py-3 text-left text-[13px]",
        "transition-colors duration-200 ease-out",
        "group-data-[state=open]/tool:bg-white/[0.02]",
        "disabled:cursor-default disabled:opacity-100",
        className
      )}
      {...props}
    >
      {icon ? <span className="shrink-0">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate text-foreground/75">{summary}</span>
      {meta ? <div className="shrink-0 flex items-center gap-2">{meta}</div> : null}
      {status ? <div className="shrink-0 flex items-center">{status}</div> : null}
      {trailing ? <div className="shrink-0 flex items-center gap-2">{trailing}</div> : null}
      {children}
    </CollapsibleTrigger>
  );
}

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export function ToolContent({ className, ...props }: ToolContentProps): React.ReactElement {
  return (
    <CollapsibleContent
      className={cn(
        "overflow-hidden will-change-[height,opacity,transform]",
        "data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down",
        className
      )}
      {...props}
    />
  );
}

export interface ToolSectionProps extends ComponentProps<"div"> {
  label: string;
  tone?: "default" | "error";
}

export function ToolSection({
  className,
  label,
  tone = "default",
  children,
  ...props
}: ToolSectionProps): React.ReactElement {
  return (
    <div className={cn("space-y-1", className)} {...props}>
      <div
        className={cn(
          "text-[10px] font-medium uppercase tracking-wide",
          tone === "error" ? "text-destructive/70" : "text-foreground/35"
        )}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

export interface ToolCodeBlockProps extends ComponentProps<"pre"> {
  tone?: "default" | "success" | "error";
}

export function ToolCodeBlock({
  className,
  tone = "default",
  children,
  ...props
}: ToolCodeBlockProps): React.ReactElement {
  return (
    <pre
      className={cn(
        "max-h-[160px] overflow-auto whitespace-pre-wrap break-all rounded-md border p-2.5 text-[11px] leading-relaxed custom-scrollbar",
        tone === "success" && "border-border/30 bg-background/60 text-green-400",
        tone === "error" && "border-destructive/20 bg-destructive/5 text-destructive/80",
        tone === "default" && "border-border/30 bg-background/60 text-foreground/65",
        className
      )}
      {...props}
    >
      {children}
    </pre>
  );
}

export interface ToolFooterProps extends ComponentProps<"div"> {}

export function ToolFooter({ className, ...props }: ToolFooterProps): React.ReactElement {
  return (
    <div
      className={cn("flex items-center gap-4 border-t border-border/30 pt-2 text-[10px] text-muted-foreground/50", className)}
      {...props}
    />
  );
}
