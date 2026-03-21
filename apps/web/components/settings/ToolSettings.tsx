"use client";

import { useEffect, useMemo, useState } from "react";
import { useAtom } from "jotai";
import { Brain, Globe, Wrench } from "lucide-react";
import { chatToolsAtom } from "@/atoms";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  getChatToolCredentials,
  getChatTools,
  updateChatToolCredentials,
  updateChatToolState
} from "@/lib/desktop-api";
import { SettingsCard, SettingsSection } from "./primitives";

function getToolIcon(iconName?: string): React.ReactElement {
  if (iconName === "Brain") return <Brain className="size-4 text-muted-foreground" />;
  if (iconName === "Globe") return <Globe className="size-4 text-muted-foreground" />;
  return <Wrench className="size-4 text-muted-foreground" />;
}

export function ToolSettings(): React.ReactElement {
  const [tools, setTools] = useAtom(chatToolsAtom);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [webCredentials, setWebCredentials] = useState<{ braveApiKey: string; tavilyApiKey: string }>({
    braveApiKey: "",
    tavilyApiKey: ""
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([getChatTools(), getChatToolCredentials("web_search")])
      .then(([toolInfos, credentials]) => {
        if (cancelled) return;
        setTools(toolInfos);
        setWebCredentials({
          braveApiKey: credentials.braveApiKey ?? "",
          tavilyApiKey: credentials.tavilyApiKey ?? ""
        });
        setErrorMessage(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setErrorMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setTools]);

  const webSearchEnabled = useMemo(
    () => tools.find((item) => item.meta.id === "web_search")?.enabled ?? false,
    [tools]
  );

  const refreshTools = async (): Promise<void> => {
    const next = await getChatTools();
    setTools(next);
  };

  return (
    <div className="space-y-6">
      <SettingsSection title="Chat 工具开关" description="控制 Chat 模式可调用的内置工具">
        <SettingsCard divided={false} className="p-0">
          {loading ? (
            <div className="px-4 py-3 text-sm text-muted-foreground">加载中...</div>
          ) : (
            <div className="divide-y divide-border/50">
              {tools.map((tool) => (
                <div key={tool.meta.id} className="flex items-center justify-between px-4 py-3">
                  <div className="mr-4 flex min-w-0 items-center gap-2">
                    {getToolIcon(tool.meta.icon)}
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{tool.meta.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{tool.meta.description}</p>
                    </div>
                  </div>
                  <Switch
                    checked={tool.enabled}
                    onCheckedChange={(checked) => {
                      void updateChatToolState(tool.meta.id, { enabled: checked })
                        .then(refreshTools)
                        .catch((error) => {
                          setErrorMessage(error instanceof Error ? error.message : String(error));
                        });
                    }}
                  />
                </div>
              ))}
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="联网搜索凭据"
        description="可选配置：Brave / Tavily API Key（未配置时默认使用 DuckDuckGo）"
      >
        <SettingsCard divided={false} className="space-y-3 p-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Brave API Key</label>
            <Input
              value={webCredentials.braveApiKey}
              onChange={(event) => {
                setWebCredentials((prev) => ({ ...prev, braveApiKey: event.target.value }));
              }}
              onBlur={() => {
                void updateChatToolCredentials("web_search", webCredentials)
                  .then(() => setErrorMessage(null))
                  .catch((error) => {
                    setErrorMessage(error instanceof Error ? error.message : String(error));
                  });
              }}
              placeholder="可选，留空则不使用 Brave"
              disabled={!webSearchEnabled}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Tavily API Key</label>
            <Input
              value={webCredentials.tavilyApiKey}
              onChange={(event) => {
                setWebCredentials((prev) => ({ ...prev, tavilyApiKey: event.target.value }));
              }}
              onBlur={() => {
                void updateChatToolCredentials("web_search", webCredentials)
                  .then(() => setErrorMessage(null))
                  .catch((error) => {
                    setErrorMessage(error instanceof Error ? error.message : String(error));
                  });
              }}
              placeholder="可选，留空则不使用 Tavily"
              disabled={!webSearchEnabled}
            />
          </div>
        </SettingsCard>
      </SettingsSection>

      {errorMessage ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {errorMessage}
        </div>
      ) : null}
    </div>
  );
}
