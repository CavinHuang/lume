import { useEffect, useMemo, useState } from "react";
import { useAtom } from "jotai";
import { Brain, Globe, ImagePlus, Sparkles, Trash2, Wrench } from "lucide-react";
import type { ChatToolInfo } from "@lume/shared";
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
} from "@/lib/desktop-api/chat";
import { SettingsCard, SettingsSection } from "./primitives";

function getToolIcon(iconName?: string): React.ReactElement {
  if (iconName === "Brain") return <Brain className="size-4 text-muted-foreground" />;
  if (iconName === "Globe") return <Globe className="size-4 text-muted-foreground" />;
  if (iconName === "ImagePlus") return <ImagePlus className="size-4 text-muted-foreground" />;
  if (iconName === "Sparkles") return <Sparkles className="size-4 text-muted-foreground" />;
  return <Wrench className="size-4 text-muted-foreground" />;
}

function extractCredentialKeysFromTemplate(template?: string): string[] {
  if (!template) return [];
  const regex = /\{\{\s*credential\.([a-zA-Z0-9_-]+)\s*\}\}/g;
  const keys: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(template)) !== null) {
    const key = (match[1] ?? "").trim();
    if (key.length > 0) {
      keys.push(key);
    }
  }
  return keys;
}

function inferCredentialKeys(tool: ChatToolInfo): string[] {
  const keys = new Set<string>();
  const httpConfig = tool.meta.httpConfig;
  for (const key of extractCredentialKeysFromTemplate(httpConfig?.urlTemplate)) {
    keys.add(key);
  }
  for (const key of extractCredentialKeysFromTemplate(httpConfig?.bodyTemplate)) {
    keys.add(key);
  }
  for (const headerValue of Object.values(httpConfig?.headers ?? {})) {
    for (const key of extractCredentialKeysFromTemplate(headerValue)) {
      keys.add(key);
    }
  }
  return Array.from(keys);
}

export function ToolSettings(): React.ReactElement {
  const [tools, setTools] = useAtom(chatToolsAtom);
  const [loading, setLoading] = useState(false);
  const [testingWebSearch, setTestingWebSearch] = useState(false);
  const [savingWebSearchCredentials, setSavingWebSearchCredentials] = useState(false);
  const [testingNanoBanana, setTestingNanoBanana] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [credentialsDialogOpen, setCredentialsDialogOpen] = useState(false);
  const [creatingCustomTool, setCreatingCustomTool] = useState(false);
  const [savingCustomCredentials, setSavingCustomCredentials] = useState(false);
  const [testingCustomToolId, setTestingCustomToolId] = useState<string | null>(null);
  const [customToolTestResults, setCustomToolTestResults] = useState<Record<string, { success: boolean; message: string }>>({});
  const [webSearchTestResult, setWebSearchTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [nanoBananaTestResult, setNanoBananaTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [credentialToolId, setCredentialToolId] = useState<string | null>(null);
  const [credentialDraft, setCredentialDraft] = useState<Record<string, string>>({});
  const [credentialFieldNames, setCredentialFieldNames] = useState<string[]>([]);
  const [newCredentialKey, setNewCredentialKey] = useState("");
  const [newCustomTool, setNewCustomTool] = useState<{
    id: string;
    name: string;
    description: string;
    urlTemplate: string;
    method: "GET" | "POST";
    headersJson: string;
    bodyTemplate: string;
    resultPath: string;
    systemPromptAppend: string;
  }>({
    id: "",
    name: "",
    description: "",
    urlTemplate: "",
    method: "GET",
    headersJson: "",
    bodyTemplate: "",
    resultPath: "",
    systemPromptAppend: ""
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [webCredentials, setWebCredentials] = useState<{ braveApiKey: string; tavilyApiKey: string }>({
    braveApiKey: "",
    tavilyApiKey: ""
  });
  const [webCredentialsDirty, setWebCredentialsDirty] = useState(false);
  const [nanoBananaCredentials, setNanoBananaCredentials] = useState<{
    apiKey: string;
    baseUrl: string;
    model: string;
  }>({
    apiKey: "",
    baseUrl: "",
    model: ""
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([
      getChatTools(),
      getChatToolCredentials("web_search"),
      getChatToolCredentials("nano_banana")
    ])
      .then(([toolInfos, web, nano]) => {
        if (cancelled) return;
        setTools(toolInfos);
        setWebCredentials((prev) => webCredentialsDirty ? prev : {
          braveApiKey: web.braveApiKey ?? "",
          tavilyApiKey: web.tavilyApiKey ?? ""
        });
        setNanoBananaCredentials({
          apiKey: nano.apiKey ?? "",
          baseUrl: nano.baseUrl ?? "",
          model: nano.model ?? ""
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
  }, [setTools, webCredentialsDirty]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onChatToolChanged(() => {
      void Promise.all([
        getChatTools(),
        getChatToolCredentials("web_search"),
        getChatToolCredentials("nano_banana")
      ]).then(([toolInfos, web, nano]) => {
        if (disposed) return;
        setTools(toolInfos);
        setWebCredentials((prev) => webCredentialsDirty ? prev : {
          braveApiKey: web.braveApiKey ?? "",
          tavilyApiKey: web.tavilyApiKey ?? ""
        });
        setNanoBananaCredentials({
          apiKey: nano.apiKey ?? "",
          baseUrl: nano.baseUrl ?? "",
          model: nano.model ?? ""
        });
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
  }, [setTools, webCredentialsDirty]);

  const webSearchEnabled = useMemo(
    () => tools.find((item) => item.meta.id === "web_search")?.enabled ?? false,
    [tools]
  );
  const nanoBananaEnabled = useMemo(
    () => tools.find((item) => item.meta.id === "nano_banana")?.enabled ?? false,
    [tools]
  );
  const builtinTools = useMemo(() => tools.filter((item) => item.meta.category === "builtin"), [tools]);
  const customTools = useMemo(() => tools.filter((item) => item.meta.category === "custom"), [tools]);
  const credentialTargetTool = useMemo(
    () => customTools.find((tool) => tool.meta.id === credentialToolId) ?? null,
    [customTools, credentialToolId]
  );

  const refreshTools = async (): Promise<void> => {
    const next = await getChatTools();
    setTools(next);
  };

  const saveWebSearchCredentials = async (): Promise<void> => {
    setSavingWebSearchCredentials(true);
    try {
      await updateChatToolCredentials("web_search", webCredentials);
      const next = await getChatToolCredentials("web_search");
      setWebCredentials({
        braveApiKey: next.braveApiKey ?? "",
        tavilyApiKey: next.tavilyApiKey ?? ""
      });
      setWebCredentialsDirty(false);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingWebSearchCredentials(false);
    }
  };

  const resetNewCustomTool = (): void => {
    setNewCustomTool({
      id: "",
      name: "",
      description: "",
      urlTemplate: "",
      method: "GET",
      headersJson: "",
      bodyTemplate: "",
      resultPath: "",
      systemPromptAppend: ""
    });
  };

  const openCustomCredentialsDialog = async (tool: ChatToolInfo): Promise<void> => {
    try {
      const credentials = await getChatToolCredentials(tool.meta.id);
      const inferred = inferCredentialKeys(tool);
      const keys = Array.from(new Set([...inferred, ...Object.keys(credentials)])).sort();
      setCredentialToolId(tool.meta.id);
      setCredentialDraft(credentials);
      setCredentialFieldNames(keys);
      setNewCredentialKey("");
      setCredentialsDialogOpen(true);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const saveCustomCredentials = async (): Promise<void> => {
    if (!credentialToolId) return;
    setSavingCustomCredentials(true);
    try {
      await updateChatToolCredentials(credentialToolId, credentialDraft);
      setErrorMessage(null);
      setCredentialsDialogOpen(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingCustomCredentials(false);
    }
  };

  const handleAddCredentialField = (): void => {
    const key = newCredentialKey.trim();
    if (!key) return;
    setCredentialFieldNames((prev) => (prev.includes(key) ? prev : [...prev, key]));
    setCredentialDraft((prev) => ({ ...prev, [key]: prev[key] ?? "" }));
    setNewCredentialKey("");
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
                setWebCredentialsDirty(true);
                setWebCredentials((prev) => ({ ...prev, braveApiKey: event.target.value }));
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
                setWebCredentialsDirty(true);
                setWebCredentials((prev) => ({ ...prev, tavilyApiKey: event.target.value }));
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
              disabled={savingWebSearchCredentials || !webSearchEnabled}
              onClick={() => { void saveWebSearchCredentials(); }}
            >
              {savingWebSearchCredentials ? "保存中..." : "保存搜索凭据"}
            </Button>
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

      <SettingsSection
        title="Nano Banana 生图凭据"
        description="配置 Gemini Image Generation API（未配置时工具不可用）"
      >
        <SettingsCard divided={false} className="space-y-3 p-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Gemini API Key</label>
            <Input
              value={nanoBananaCredentials.apiKey}
              onChange={(event) => {
                setNanoBananaCredentials((prev) => ({ ...prev, apiKey: event.target.value }));
              }}
              onBlur={() => {
                void updateChatToolCredentials("nano_banana", nanoBananaCredentials)
                  .then(() => setErrorMessage(null))
                  .catch((error) => {
                    setErrorMessage(error instanceof Error ? error.message : String(error));
                  });
              }}
              placeholder="必填，用于调用 Gemini 生图接口"
              disabled={!nanoBananaEnabled}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Base URL（可选）</label>
            <Input
              value={nanoBananaCredentials.baseUrl}
              onChange={(event) => {
                setNanoBananaCredentials((prev) => ({ ...prev, baseUrl: event.target.value }));
              }}
              onBlur={() => {
                void updateChatToolCredentials("nano_banana", nanoBananaCredentials)
                  .then(() => setErrorMessage(null))
                  .catch((error) => {
                    setErrorMessage(error instanceof Error ? error.message : String(error));
                  });
              }}
              placeholder="默认 https://generativelanguage.googleapis.com"
              disabled={!nanoBananaEnabled}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">模型（可选）</label>
            <Input
              value={nanoBananaCredentials.model}
              onChange={(event) => {
                setNanoBananaCredentials((prev) => ({ ...prev, model: event.target.value }));
              }}
              onBlur={() => {
                void updateChatToolCredentials("nano_banana", nanoBananaCredentials)
                  .then(() => setErrorMessage(null))
                  .catch((error) => {
                    setErrorMessage(error instanceof Error ? error.message : String(error));
                  });
              }}
              placeholder="默认 gemini-3.1-flash-image-preview"
              disabled={!nanoBananaEnabled}
            />
          </div>
          <div className="flex items-center gap-3 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={testingNanoBanana}
              onClick={() => {
                setTestingNanoBanana(true);
                setNanoBananaTestResult(null);
                void testChatTool("nano_banana")
                  .then((result) => {
                    setNanoBananaTestResult(result);
                    setErrorMessage(null);
                  })
                  .catch((error) => {
                    setNanoBananaTestResult({
                      success: false,
                      message: error instanceof Error ? error.message : String(error)
                    });
                  })
                  .finally(() => {
                    setTestingNanoBanana(false);
                  });
              }}
            >
              {testingNanoBanana ? "测试中..." : "测试生图连接"}
            </Button>
            {nanoBananaTestResult ? (
              <span className={nanoBananaTestResult.success ? "text-xs text-green-600" : "text-xs text-destructive"}>
                {nanoBananaTestResult.message}
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
              <div className="space-y-1.5">
                <Label htmlFor="custom-tool-headers-json">Headers（可选 JSON）</Label>
                <Input
                  id="custom-tool-headers-json"
                  placeholder='例如: {"Authorization":"Bearer {{credential.apiKey}}"}'
                  value={newCustomTool.headersJson}
                  onChange={(event) => {
                    setNewCustomTool((prev) => ({ ...prev, headersJson: event.target.value }));
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="custom-tool-body-template">Body 模板（可选）</Label>
                <Input
                  id="custom-tool-body-template"
                  placeholder='例如: {"query":"{{query}}"}'
                  value={newCustomTool.bodyTemplate}
                  onChange={(event) => {
                    setNewCustomTool((prev) => ({ ...prev, bodyTemplate: event.target.value }));
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="custom-tool-result-path">结果路径（可选）</Label>
                <Input
                  id="custom-tool-result-path"
                  placeholder="例如: data.items"
                  value={newCustomTool.resultPath}
                  onChange={(event) => {
                    setNewCustomTool((prev) => ({ ...prev, resultPath: event.target.value }));
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="custom-tool-system-prompt-append">System Prompt 附加（可选）</Label>
                <Input
                  id="custom-tool-system-prompt-append"
                  placeholder="例如: 查询失败时请明确说明重试建议"
                  value={newCustomTool.systemPromptAppend}
                  onChange={(event) => {
                    setNewCustomTool((prev) => ({ ...prev, systemPromptAppend: event.target.value }));
                  }}
                />
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
                    let headers: Record<string, string> | undefined;
                    const headersJson = newCustomTool.headersJson.trim();
                    if (headersJson.length > 0) {
                      try {
                        const parsed = JSON.parse(headersJson) as unknown;
                        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                          setErrorMessage("Headers JSON 必须是对象");
                          return;
                        }
                        const entries = Object.entries(parsed as Record<string, unknown>);
                        const invalid = entries.find((entry) => typeof entry[1] !== "string");
                        if (invalid) {
                          setErrorMessage(`Headers 字段 ${invalid[0]} 必须是字符串`);
                          return;
                        }
                        headers = Object.fromEntries(entries as Array<[string, string]>);
                      } catch (error) {
                        setErrorMessage(error instanceof Error ? `Headers JSON 解析失败: ${error.message}` : "Headers JSON 解析失败");
                        return;
                      }
                    }

                    const bodyTemplate = newCustomTool.bodyTemplate.trim();
                    const resultPath = newCustomTool.resultPath.trim();
                    const systemPromptAppend = newCustomTool.systemPromptAppend.trim();
                    const payload = {
                      id: newCustomTool.id.trim(),
                      name: newCustomTool.name.trim(),
                      description: newCustomTool.description.trim(),
                      category: "custom" as const,
                      executorType: "http" as const,
                      httpConfig: {
                        urlTemplate: newCustomTool.urlTemplate.trim(),
                        method: newCustomTool.method,
                        headers,
                        bodyTemplate: bodyTemplate.length > 0 ? bodyTemplate : undefined,
                        resultPath: resultPath.length > 0 ? resultPath : undefined
                      },
                      systemPromptAppend: systemPromptAppend.length > 0 ? systemPromptAppend : undefined
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

        <Dialog open={credentialsDialogOpen} onOpenChange={setCredentialsDialogOpen}>
          <DialogContent className="sm:max-w-[520px]">
            <DialogHeader>
              <DialogTitle>配置工具凭据{credentialTargetTool ? ` · ${credentialTargetTool.meta.name}` : ""}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              {credentialFieldNames.length === 0 ? (
                <div className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  未检测到模板中的 `credential.*` 占位符，可手动新增凭据键。
                </div>
              ) : null}
              {credentialFieldNames.map((key) => (
                <div key={key} className="space-y-1.5">
                  <Label htmlFor={`custom-credential-${key}`}>{key}</Label>
                  <Input
                    id={`custom-credential-${key}`}
                    value={credentialDraft[key] ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      setCredentialDraft((prev) => ({ ...prev, [key]: value }));
                    }}
                    placeholder={`请输入 ${key}`}
                  />
                </div>
              ))}
              <div className="flex items-center gap-2">
                <Input
                  value={newCredentialKey}
                  onChange={(event) => setNewCredentialKey(event.target.value)}
                  placeholder="新增凭据键名，例如 apiKey"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleAddCredentialField}
                >
                  新增
                </Button>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setCredentialsDialogOpen(false);
                  }}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  disabled={savingCustomCredentials}
                  onClick={() => { void saveCustomCredentials(); }}
                >
                  {savingCustomCredentials ? "保存中..." : "保存凭据"}
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
                    {customToolTestResults[tool.meta.id] ? (
                      <p className={customToolTestResults[tool.meta.id]?.success ? "mt-1 text-xs text-green-600" : "mt-1 text-xs text-destructive"}>
                        {customToolTestResults[tool.meta.id]?.message}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => { void openCustomCredentialsDialog(tool); }}
                    >
                      凭据
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={testingCustomToolId === tool.meta.id}
                      onClick={() => {
                        setTestingCustomToolId(tool.meta.id);
                        setCustomToolTestResults((prev) => {
                          const next = { ...prev };
                          delete next[tool.meta.id];
                          return next;
                        });
                        void testChatTool(tool.meta.id)
                          .then((result) => {
                            setCustomToolTestResults((prev) => ({
                              ...prev,
                              [tool.meta.id]: result
                            }));
                            setErrorMessage(null);
                          })
                          .catch((error) => {
                            setCustomToolTestResults((prev) => ({
                              ...prev,
                              [tool.meta.id]: {
                                success: false,
                                message: error instanceof Error ? error.message : String(error)
                              }
                            }));
                          })
                          .finally(() => {
                            setTestingCustomToolId((current) => (current === tool.meta.id ? null : current));
                          });
                      }}
                    >
                      {testingCustomToolId === tool.meta.id ? "测试中..." : "测试"}
                    </Button>
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
                      size="sm"
                      variant="ghost"
                      className="text-muted-foreground hover:text-destructive"
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
