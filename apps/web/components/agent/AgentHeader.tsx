"use client";

import { useRef, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { ArrowLeft, Check, FolderOpen, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { agentSessionsAtom, currentAgentSessionAtom } from "@/atoms";
import { updateAgentSessionTitle } from "@/lib/desktop-api";

interface AgentHeaderProps {
  onToggleFileBrowser?: () => void;
  fileBrowserOpen?: boolean;
  onOpenSession?: (sessionId: string) => void;
}

export function AgentHeader({ onToggleFileBrowser, fileBrowserOpen, onOpenSession }: AgentHeaderProps): React.ReactElement | null {
  const session = useAtomValue(currentAgentSessionAtom);
  const [sessions, setSessions] = useAtom(agentSessionsAtom);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  if (!session) return null;

  const parentSession = session.parentSessionId
    ? sessions.find((s) => s.id === session.parentSessionId)
    : null;

  const startEdit = (): void => {
    setEditTitle(session.title);
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const saveTitle = async (): Promise<void> => {
    const trimmed = editTitle.trim();
    if (!trimmed || trimmed === session.title) {
      setEditing(false);
      return;
    }
    const updated = await updateAgentSessionTitle(session.id, trimmed);
    setSessions(sessions.map((item) => (item.id === updated.id ? updated : item)));
    setEditing(false);
  };

  return (
    <div className="relative z-[51] flex flex-col titlebar-no-drag">
      {/* 父 session 返回条 */}
      {parentSession && onOpenSession ? (
        <button
          type="button"
          onClick={() => onOpenSession(parentSession.id)}
          className="flex items-center gap-1.5 border-b bg-muted/40 px-4 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground animate-slide-in-down"
        >
          <ArrowLeft className="size-3 shrink-0" />
          <span className="truncate">{parentSession.title}</span>
        </button>
      ) : null}

      {/* 主标题行 */}
      <div className="flex h-[48px] items-center gap-2 px-4">
        {editing ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <input
              ref={inputRef}
              value={editTitle}
              onChange={(event) => setEditTitle(event.target.value)}
              onBlur={() => { void saveTitle(); }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void saveTitle();
                } else if (event.key === "Escape") {
                  setEditing(false);
                }
              }}
              className="min-w-0 flex-1 border-b border-primary/50 bg-transparent px-0 py-0.5 text-sm font-medium outline-none"
              maxLength={100}
            />
            <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => { void saveTitle(); }} className="p-1 text-muted-foreground transition-colors hover:text-foreground">
              <Check className="size-3.5" />
            </button>
            <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => setEditing(false)} className="p-1 text-muted-foreground transition-colors hover:text-foreground">
              <X className="size-3.5" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={startEdit}
            className="group flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm font-medium text-foreground transition-colors hover:text-foreground/80"
          >
            <span className="truncate">{session.title}</span>
            <Pencil className="size-3 shrink-0 opacity-40 transition-opacity group-hover:opacity-70" />
          </button>
        )}

        {onToggleFileBrowser ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn("h-8 w-8 shrink-0", fileBrowserOpen && "bg-accent text-accent-foreground")}
                onClick={onToggleFileBrowser}
              >
                <FolderOpen className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>{fileBrowserOpen ? "关闭文件浏览器" : "打开文件浏览器"}</p>
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}
