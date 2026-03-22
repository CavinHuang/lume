"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useAtomValue } from "jotai";
import { Check, FolderOpen, Pencil, X } from "lucide-react";
import {
  agentWorkspacesAtom,
  currentAgentWorkspaceIdAtom
} from "@/atoms";
import { readAgentBootstrapFile, writeAgentBootstrapFile } from "@/lib/desktop-api";
import { Button } from "@/components/ui/button";
import { MemoryBrowser } from "@/components/memory/MemoryBrowser";
import { SettingsCard, SettingsSection } from "./primitives";

const IDENTITY_FILE_TYPES = ["SOUL", "IDENTITY", "USER"] as const;
type IdentityFileType = typeof IDENTITY_FILE_TYPES[number];

const FILE_TYPE_META: Record<IdentityFileType, { label: string; description: string; placeholder: string }> = {
  SOUL: {
    label: "SOUL.md",
    description: "Agent 人格与行为准则",
    placeholder: "定义 Agent 的核心人格、语气风格和行为边界..."
  },
  IDENTITY: {
    label: "IDENTITY.md",
    description: "工作区身份定义",
    placeholder: "定义当前工作区的项目背景、技术栈和约定..."
  },
  USER: {
    label: "USER.md",
    description: "用户偏好与背景信息",
    placeholder: "描述你的角色、偏好和工作习惯，帮助 Agent 更好地协作..."
  }
};

interface FileEditorProps {
  fileType: IdentityFileType;
  content: string;
  workspaceSlug: string;
  onSaved: (fileType: IdentityFileType, content: string) => void;
}

function FileEditor({ fileType, content, workspaceSlug, onSaved }: FileEditorProps): React.ReactElement {
  const meta = FILE_TYPE_META[fileType];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const handleEdit = useCallback(() => {
    setDraft(content);
    setEditing(true);
    setMessage("");
  }, [content]);

  const handleCancel = useCallback(() => {
    setEditing(false);
    setDraft(content);
    setMessage("");
  }, [content]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setMessage("");
    try {
      await writeAgentBootstrapFile(workspaceSlug, fileType, draft);
      onSaved(fileType, draft);
      setEditing(false);
      setMessage("已保存");
      setTimeout(() => setMessage(""), 2000);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [workspaceSlug, fileType, draft, onSaved]);

  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <span className="text-xs font-medium">{meta.label}</span>
          <span className="ml-2 text-xs text-muted-foreground">{meta.description}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {message ? (
            <span className="text-xs text-muted-foreground">{message}</span>
          ) : null}
          {editing ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={handleCancel}
                className="h-7 px-2"
              >
                <X size={14} />
                <span className="ml-1">取消</span>
              </Button>
              <Button
                size="sm"
                disabled={saving}
                onClick={() => { void handleSave(); }}
                className="h-7 px-2"
              >
                <Check size={14} />
                <span className="ml-1">{saving ? "保存中..." : "保存"}</span>
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={handleEdit}
              className="h-7 px-2"
            >
              <Pencil size={14} />
              <span className="ml-1">编辑</span>
            </Button>
          )}
        </div>
      </div>
      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={meta.placeholder}
          rows={10}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      ) : content ? (
        <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded border bg-muted/30 p-3 text-xs text-foreground/80">
          {content}
        </pre>
      ) : (
        <div className="rounded border border-dashed bg-muted/10 px-3 py-6 text-center text-xs text-muted-foreground">
          暂无内容，点击编辑创建
        </div>
      )}
    </div>
  );
}

export function IdentitySettings(): React.ReactElement {
  const workspaces = useAtomValue(agentWorkspacesAtom);
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom);
  const workspace = useMemo(
    () => workspaces.find((item) => item.id === currentWorkspaceId) ?? null,
    [workspaces, currentWorkspaceId]
  );

  const workspaceSlug = workspace?.slug ?? "";
  const [identityContent, setIdentityContent] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!workspaceSlug) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const results: Record<string, string> = {};
      for (const fileType of IDENTITY_FILE_TYPES) {
        try {
          const { content } = await readAgentBootstrapFile(workspaceSlug, fileType);
          if (!cancelled && content.trim()) results[fileType] = content;
        } catch { /* ignore */ }
      }
      if (!cancelled) {
        setIdentityContent(results);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceSlug]);

  const handleSaved = useCallback((fileType: IdentityFileType, content: string) => {
    setIdentityContent((prev) => {
      const next = { ...prev };
      if (content.trim()) {
        next[fileType] = content;
      } else {
        delete next[fileType];
      }
      return next;
    });
  }, []);

  if (!workspace) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <FolderOpen size={48} className="mb-4 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">请先在 Agent 模式下选择或创建一个工作区</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <SettingsSection title="身份与人格" description={`工作区: ${workspace.name} · 定义 Agent 的人格、身份和用户偏好`}>
        <SettingsCard divided={false}>
          <div className="space-y-3 p-3">
            {loading ? (
              <div className="py-8 text-center text-sm text-muted-foreground">加载中...</div>
            ) : (
              IDENTITY_FILE_TYPES.map((fileType) => (
                <FileEditor
                  key={fileType}
                  fileType={fileType}
                  content={identityContent[fileType] ?? ""}
                  workspaceSlug={workspaceSlug}
                  onSaved={handleSaved}
                />
              ))
            )}
          </div>
        </SettingsCard>
      </SettingsSection>

      {workspaceSlug && (
        <SettingsSection title="记忆浏览器" description="搜索和浏览工作区记忆内容">
          <SettingsCard divided={false}>
            <div className="p-3">
              <MemoryBrowser workspaceSlug={workspaceSlug} />
            </div>
          </SettingsCard>
        </SettingsSection>
      )}
    </div>
  );
}
