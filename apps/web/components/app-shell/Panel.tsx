"use client";

import { cn } from "@/lib/utils";

type PanelProps = {
  className?: string;
  children: React.ReactNode;
};

export function Panel({ className, children }: PanelProps): React.ReactElement {
  return <section className={cn("w-full min-w-0 overflow-hidden rounded-2xl border border-border/60", className)}>{children}</section>;
}
