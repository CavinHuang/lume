"use client";

import { cn } from "@/lib/utils";

type PanelHeaderProps = {
  title: string;
  actions?: React.ReactNode;
  className?: string;
};

export function PanelHeader({ title, actions, className }: PanelHeaderProps): React.ReactElement {
  return (
    <div className={cn("flex items-center justify-between border-b border-border px-4 py-3", className)}>
      <h2 className="text-sm font-semibold">{title}</h2>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
