"use client";

import { useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import type { McpServerEntry, McpTransportType, WorkspaceMcpConfig } from "@lume/shared";
import { Button } from "@/components/ui/button";
import { getAgentWorkspaceMcpConfig, saveAgentWorkspaceMcpConfig } from "@/lib/desktop-api";
import {
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsToggle
} from "./primitives";

type EditingServer = {
  name: string;
  entry: McpServerEntry;
};

type McpServerFormProps = {
  server: EditingServer | null;
  workspaceSlug: string;
  onSaved: () => void;
  onCancel: () => void;
};

const TRANSPORT_OPTIONS = [
  { value: "stdio", label: "stdio（命令行）" },
  { value: "http", label: "HTTP" },
  { value: "sse", label: "SSE" }
];

function parseKeyValueText(text: string, separator: "=" | ":"): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(separator);
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

function serializeKeyValueText(record: Record<string, string> | undefined, separator: "=" | ":"): string {
  if (!record) return "";
  return Object.entries(record)
    .map(([key, value]) => `${key}${separator}${separator === ":" ? " " : ""}${value}`)
    .join("\n");
}

export function McpServerForm({
  server,
  workspaceSlug,
  onSaved,
  onCancel
}: McpServerFormProps): React.ReactElement {
  const isEdit = server !== null;
  const [name, setName] = useState(server?.name ?? "");
  const [transportType, setTransportType] = useState<McpTransportType>(server?.entry.type ?? "stdio");
  const [enabled, setEnabled] = useState(server?.entry.enabled ?? true);
  const [command, setCommand] = useState(server?.entry.command ?? "");
  const [argsText, setArgsText] = useState(server?.entry.args?.join(", ") ?? "");
  const [envText, setEnvText] = useState(serializeKeyValueText(server?.entry.env, "="));
  const [url, setUrl] = useState(server?.entry.url ?? "");
  const [headersText, setHeadersText] = useState(serializeKeyValueText(server?.entry.headers, ":"));
  const [saving, setSaving] = useState(false);

  const canSubmit = (): boolean => {
    if (!name.trim()) return false;
    if (transportType === "stdio" && !command.trim()) return false;
    if (transportType !== "stdio" && !url.trim()) return false;
    return true;
  };

  const buildEntry = (): McpServerEntry => {
    const base: McpServerEntry = { type: transportType, enabled };
    if (transportType === "stdio") {
      base.command = command.trim();
      const args = argsText.split(",").map((item) => item.trim()).filter(Boolean);
      if (args.length) base.args = args;
      const env = parseKeyValueText(envText, "=");
      if (Object.keys(env).length) base.env = env;
      return base;
    }
    base.url = url.trim();
    const headers = parseKeyValueText(headersText, ":");
    if (Object.keys(headers).length) base.headers = headers;
    return base;
  };

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!canSubmit()) return;
    setSaving(true);
    try {
      const config = await getAgentWorkspaceMcpConfig(workspaceSlug);
      const nextConfig: WorkspaceMcpConfig = {
        servers: {
          ...config.servers,
          [name.trim()]: buildEntry()
        }
      };
      await saveAgentWorkspaceMcpConfig(workspaceSlug, nextConfig);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="flex flex-col gap-3.5" onSubmit={handleSubmit}>
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="icon" onClick={onCancel}>
          <ArrowLeft size={16} />
        </Button>
        <h3 className="flex-1 text-lg font-semibold">{isEdit ? "编辑 MCP 服务器" : "添加 MCP 服务器"}</h3>
        <div className="flex items-center gap-1.5">
          <Button type="button" variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button type="submit" disabled={!canSubmit() || saving}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            {isEdit ? "保存修改" : "创建服务器"}
          </Button>
        </div>
      </div>

      <SettingsSection title="基本信息">
        <SettingsCard>
          <SettingsInput
            label="服务器名称"
            value={name}
            onChange={setName}
            placeholder="例如: github-mcp"
            required
            disabled={isEdit}
          />
          <SettingsSelect
            label="传输类型"
            value={transportType}
            onValueChange={(value) => setTransportType(value as McpTransportType)}
            options={TRANSPORT_OPTIONS}
          />

          {transportType === "stdio" ? (
            <>
              <SettingsInput label="命令" value={command} onChange={setCommand} required />
              <SettingsInput
                label="参数"
                value={argsText}
                onChange={setArgsText}
                placeholder="逗号分隔，例如: -y, @pkg/server"
              />
              <div className="flex flex-col gap-1.5 px-1 py-1">
                <div className="text-sm font-semibold text-slate-200">环境变量</div>
                <div className="text-xs text-slate-400">每行一个，格式: KEY=VALUE</div>
                <textarea
                  value={envText}
                  onChange={(event) => setEnvText(event.target.value)}
                  rows={4}
                  className="min-h-[76px] resize-y rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400"
                />
              </div>
            </>
          ) : (
            <>
              <SettingsInput label="URL" value={url} onChange={setUrl} required />
              <div className="flex flex-col gap-1.5 px-1 py-1">
                <div className="text-sm font-semibold text-slate-200">请求头</div>
                <div className="text-xs text-slate-400">每行一个，格式: Key: Value</div>
                <textarea
                  value={headersText}
                  onChange={(event) => setHeadersText(event.target.value)}
                  rows={4}
                  className="min-h-[76px] resize-y rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400"
                />
              </div>
            </>
          )}

          <SettingsToggle
            label="启用此服务器"
            description="关闭后此 MCP 不会在 Agent 会话加载"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </SettingsCard>
      </SettingsSection>
    </form>
  );
}
