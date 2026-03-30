import { useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import type { McpServerEntry, McpTransportType, WorkspaceMcpConfig } from "@lume/shared";
import { Button } from "@/components/ui/button";
import { getAgentWorkspaceMcpConfig, saveAgentWorkspaceMcpConfig } from "@/lib/desktop-api/agent";
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
  { value: "http", label: "HTTP（Streamable HTTP）" },
  { value: "sse", label: "SSE（Server-Sent Events）" }
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
    <form className="space-y-6" onSubmit={handleSubmit}>
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="h-8 w-8" type="button" onClick={onCancel}>
          <ArrowLeft size={18} />
        </Button>
        <h3 className="flex-1 text-lg font-medium text-foreground">{isEdit ? "编辑 MCP 服务器" : "添加 MCP 服务器"}</h3>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" type="button" onClick={onCancel}>
            取消
          </Button>
          <Button size="sm" type="submit" disabled={!canSubmit() || saving}>
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
                placeholder="逗号分隔，例如: -y, @modelcontextprotocol/server-github"
                description="多个参数用逗号分隔"
              />
              <div className="space-y-2 px-4 py-3">
                <div>
                  <div className="text-sm font-medium text-foreground">环境变量</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">每行一个，格式: KEY=VALUE</div>
                </div>
                <textarea
                  value={envText}
                  onChange={(event) => setEnvText(event.target.value)}
                  placeholder="GITHUB_TOKEN=ghp_xxx&#10;DEBUG=true"
                  rows={3}
                  className="flex w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                />
              </div>
            </>
          ) : (
            <>
              <SettingsInput label="URL" value={url} onChange={setUrl} required />
              <div className="space-y-2 px-4 py-3">
                <div>
                  <div className="text-sm font-medium text-foreground">请求头</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">每行一个，格式: Key: Value</div>
                </div>
                <textarea
                  value={headersText}
                  onChange={(event) => setHeadersText(event.target.value)}
                  placeholder="Authorization: Bearer xxx&#10;X-Custom-Header: value"
                  rows={3}
                  className="flex w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                />
              </div>
            </>
          )}

          <SettingsToggle
            label="启用此服务器"
            description="关闭后该 MCP 服务器不会在 Agent 会话中加载"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </SettingsCard>
      </SettingsSection>
    </form>
  );
}
