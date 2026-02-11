"use client";

import { useEffect, useState } from "react";
import type { FileEntry } from "@lume/shared";
import { deleteAgentFile, listAgentDirectory } from "@/lib/desktop-api";

type FileBrowserProps = {
  workspaceSlug: string;
  sessionId: string;
  rootPath: string;
};

type TreeItemProps = {
  entry: FileEntry;
  workspaceSlug: string;
  sessionId: string;
  onDeleted: () => void;
};

function TreeItem({ entry, workspaceSlug, sessionId, onDeleted }: TreeItemProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  const loadChildren = async (): Promise<void> => {
    const items = await listAgentDirectory(workspaceSlug, sessionId, entry.path);
    setChildren(items);
    setLoaded(true);
  };

  const onClick = async (): Promise<void> => {
    if (!entry.isDirectory) return;
    if (!expanded && !loaded) {
      await loadChildren();
    }
    setExpanded((prev) => !prev);
  };

  const onDelete = async (event: React.MouseEvent): Promise<void> => {
    event.stopPropagation();
    if (!window.confirm(`确认删除 ${entry.name} ?`)) return;
    await deleteAgentFile(workspaceSlug, sessionId, entry.path);
    onDeleted();
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex cursor-pointer items-center justify-between gap-2 rounded-md border border-slate-700 bg-slate-900/70 px-2 py-1.5 hover:bg-slate-800/80" onClick={() => void onClick()}>
        <span className="truncate text-xs">
          {entry.isDirectory ? (expanded ? "📂" : "📁") : "📄"} {entry.name}
        </span>
        <button type="button" className="rounded border border-red-900 bg-red-950/30 px-1.5 py-0.5 text-[11px] text-red-300 hover:bg-red-900/40" onClick={(event) => void onDelete(event)}>
          Del
        </button>
      </div>
      {entry.isDirectory && expanded ? (
        <div className="ml-3 flex flex-col gap-1">
          {children.map((child) => (
            <TreeItem
              key={child.path}
              entry={child}
              workspaceSlug={workspaceSlug}
              sessionId={sessionId}
              onDeleted={onDeleted}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function FileBrowser({
  workspaceSlug,
  sessionId,
  rootPath
}: FileBrowserProps): React.ReactElement {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const items = await listAgentDirectory(workspaceSlug, sessionId, rootPath);
      setEntries(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
      setEntries([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, [workspaceSlug, sessionId, rootPath]);

  return (
    <aside className="flex min-h-0 flex-col gap-2 rounded-xl border border-slate-700 bg-slate-950/50 p-2">
      <header className="flex items-center justify-between gap-2">
        <strong>Files</strong>
        <button type="button" className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-xs hover:bg-slate-700" onClick={() => void reload()}>
          Refresh
        </button>
      </header>
      <p className="text-xs text-muted-foreground">{rootPath}</p>
      {loading ? <p className="text-xs text-muted-foreground">Loading...</p> : null}
      {error ? <p className="text-xs text-red-300">{error}</p> : null}
      <div className="min-h-0 overflow-auto">
        {entries.map((entry) => (
          <TreeItem
            key={entry.path}
            entry={entry}
            workspaceSlug={workspaceSlug}
            sessionId={sessionId}
            onDeleted={() => void reload()}
          />
        ))}
      </div>
    </aside>
  );
}
