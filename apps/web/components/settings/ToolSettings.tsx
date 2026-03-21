"use client";

import { useEffect, useMemo, useState } from "react";
import { useAtom } from "jotai";
import { Brain, Globe, Trash2, Wrench } from "lucide-react";
import { chatToolsAtom } from "@/atoms";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  createCustomChatTool,
  deleteCustomChatTool,
  getChatToolCredentials,
  getChatTools,
  onChatToolChanged,
  testChatTool,
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
  const [testingWebSearch, setTestingWebSearch] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [creatingCustomTool, setCreatingCustomTool] = useState(false);
  const [webSearchTestResult, setWebSearchTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [newCustomTool, setNewCustomTool] = useState<{
    id: string;
    name: string;
    description: string;
    urlTemplate: string;
    method: "GET" | "POST";
  }>({
    id: "",
    name: "",
    description: "",
    urlTemplate: "",
    method: "GET"
  });
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

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onChatToolChanged(() => {
      void getChatTools().then((toolInfos) => {
        if (!disposed) {
          setTools(toolInfos);
        }
      }).catch((error) => {
        console.error("[ToolSettings] 工具配置变更刷新失败:", error);
      });
    }).then((fn) => {
      if (disposed) {
        void fn();
        return;
      }
      unlisten = fn;
    }).catch((error) => {
      console.error("[ToolSettings] 订阅工具配置变更失败:", error);
    });

    return () => {
      disposed = true;
      if (unlisten) {
        void unlisten();
      }
    };
  }, [setTools]);

  const webSearchEnabled = useMemo(
    () => tools.find((item) => item.meta.id === "web_search")?.enabled ?? false,
    [tools]
  );
  const builtinTools = useMemo(() => tools.filter((item) => item.meta.category === "builtin"), [tools]);
  const customTools = useMemo(() => tools.filter((item) => item.meta.category === "custom"), [tools]);

  const refreshTools = async (): Promise<void> => {
    const next = await getChatTools();
    setTools(next);
  };

  const resetNewCustomTool = (): void => {
    setNewCustomTool({
      id: "",
      name: "",
      description: "",
      urlTemplate: "",
      method: "GET"
    });
  };

  return (
    <div className="space-y-6">
      <SettingsSection title="Chat 工具开关" description="控制 Chat 模式可调用的内置工具">
        <SettingsCard divided={false} className="p-0">
          {loading ? (
            <div className="px-4 py-3 text-sm text-muted-foreground">加载中...</div>
          ) : (
            <div className="divide-y divide-border/50">
              {builtinTools.map((tool) => (
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
          <div className="flex items-center gap-3 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={testingWebSearch}
              onClick={() => {
                setTestingWebSearch(true);
                setWebSearchTestResult(null);
                void testChatTool("web_search")
                  .then((result) => {
                    setWebSearchTestResult(result);
                    setErrorMessage(null);
                  })
                  .catch((error) => {
                    setWebSearchTestResult({
                      success: false,
                      message: error instanceof Error ? error.message : String(error)
                    });
                  })
                  .finally(() => {
                    setTestingWebSearch(false);
                  });
              }}
            >
              {testingWebSearch ? "测试中..." : "测试联网搜索"}
            </Button>
            {webSearchTestResult ? (
              <span className={webSearchTestResult.success ? "text-xs text-green-600" : "text-xs text-destructive"}>
                {webSearchTestResult.message}
              </span>
            ) : null}
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="自定义工具" description="支持注册简单 HTTP 工具定义（当前仅配置管理）">
        <div className="mb-2 flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              resetNewCustomTool();
              setCreateDialogOpen(true);
            }}
          >
            新增自定义工具
          </Button>
        </div>
        <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
          <DialogContent className="sm:max-w-[520px]">
            <DialogHeader>
              <DialogTitle>新增自定义工具</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="custom-tool-id">工具 ID</Label>
                <Input
                  id="custom-tool-id"
                  placeholder="例如: jira_search"
                  value={newCustomTool.id}
                  onChange={(event) => {
                    setNewCustomTool((prev) => ({ ...prev, id: event.target.value }));
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="custom-tool-name">名称</Label>
                <Input
                  id="custom-tool-name"
                  placeholder="例如: Jira 搜索"
                  value={newCustomTool.name}
                  onChange={(event) => {
                    setNewCustomTool((prev) => ({ ...prev, name: event.target.value }));
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="custom-tool-description">描述</Label>
                <Input
                  id="custom-tool-description"
                  placeholder="例如: 查询 Jira issue 列表"
                  value={newCustomTool.description}
                  onChange={(event) => {
                    setNewCustomTool((prev) => ({ ...prev, description: event.target.value }));
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="custom-tool-url-template">URL 模板</Label>
                <Input
                  id="custom-tool-url-template"
                  placeholder="https://example.com/api/issues?q={{query}}"
                  value={newCustomTool.urlTemplate}
                  onChange={(event) => {
                    setNewCustomTool((prev) => ({ ...prev, urlTemplate: event.target.value }));
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="custom-tool-method">HTTP 方法</Label>
                <select
                  id="custom-tool-method"
                  value={newCustomTool.method}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  onChange={(event) => {
                    const method = event.target.value === "POST" ? "POST" : "GET";
                    setNewCustomTool((prev) => ({ ...prev, method }));
                  }}
                >
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                </select>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setCreateDialogOpen(false);
                  }}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  disabled={creatingCustomTool}
                  onClick={() => {
                    const payload = {
                      id: newCustomTool.id.trim(),
                      name: newCustomTool.name.trim(),
                      description: newCustomTool.description.trim(),
                      category: "custom" as const,
                      executorType: "http" as const,
                      httpConfig: {
                        urlTemplate: newCustomTool.urlTemplate.trim(),
                        method: newCustomTool.method
                      }
                    };
                    if (!payload.id || !payload.name || !payload.description || !payload.httpConfig.urlTemplate) {
                      setErrorMessage("请完整填写工具 ID、名称、描述与 URL 模板");
                      return;
                    }

                    setCreatingCustomTool(true);
                    void createCustomChatTool(payload)
                      .then(async () => {
                        await refreshTools();
                        setErrorMessage(null);
                        setCreateDialogOpen(false);
                        resetNewCustomTool();
                      })
                      .catch((error) => {
                        setErrorMessage(error instanceof Error ? error.message : String(error));
                      })
                      .finally(() => {
                        setCreatingCustomTool(false);
                      });
                  }}
                >
                  {creatingCustomTool ? "创建中..." : "创建工具"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        <SettingsCard divided={false} className="p-0">
          {customTools.length === 0 ? (
            <div className="px-4 py-3 text-sm text-muted-foreground">暂无自定义工具</div>
          ) : (
            <div className="divide-y divide-border/50">
              {customTools.map((tool) => (
                <div key={tool.meta.id} className="flex items-center justify-between px-4 py-3">
                  <div className="mr-4 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">{tool.meta.name}</p>
                      {tool.meta.httpConfig?.method ? (
                        <span className="text-xs text-muted-foreground">{tool.meta.httpConfig.method}</span>
                      ) : null}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{tool.meta.description}</p>
                    {tool.meta.httpConfig?.urlTemplate ? (
                      <p className="truncate text-xs text-muted-foreground/70">{tool.meta.httpConfig.urlTemplate}</p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
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
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        void deleteCustomChatTool(tool.meta.id)
                          .then(refreshTools)
                          .catch((error) => {
                            setErrorMessage(error instanceof Error ? error.message : String(error));
                          });
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
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
