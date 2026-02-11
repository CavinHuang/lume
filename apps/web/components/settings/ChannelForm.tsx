"use client";

import { useEffect, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  X,
  XCircle,
  Zap
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  PROVIDER_DEFAULT_URLS,
  PROVIDER_LABELS,
  type Channel,
  type ChannelCreateInput,
  type ChannelModel,
  type ChannelTestResult,
  type FetchModelsResult,
  type ProviderType
} from "@lume/shared";
import {
  createChannel,
  decryptChannelApiKey,
  fetchChannelModels,
  testChannelDirect,
  updateChannel
} from "@/lib/desktop-api";
import {
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsToggle
} from "./primitives";

type ChannelFormProps = {
  channel: Channel | null;
  onSaved: () => void;
  onCancel: () => void;
};

const PROVIDER_OPTIONS: ProviderType[] = [
  "anthropic",
  "openai",
  "deepseek",
  "google",
  "moonshot",
  "zhipu",
  "minimax",
  "doubao",
  "qwen",
  "custom"
];

const PROVIDER_SELECT_OPTIONS = PROVIDER_OPTIONS.map((provider) => ({
  value: provider,
  label: PROVIDER_LABELS[provider]
}));

const PROVIDER_CHAT_PATHS: Record<ProviderType, string> = {
  anthropic: "/v1/messages",
  openai: "/chat/completions",
  deepseek: "/chat/completions",
  google: "/v1beta/models/{model}:generateContent",
  moonshot: "/chat/completions",
  zhipu: "/chat/completions",
  minimax: "/chat/completions",
  doubao: "/chat/completions",
  qwen: "/chat/completions",
  custom: "/chat/completions"
};

function buildPreviewUrl(baseUrl: string, provider: ProviderType): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (provider === "anthropic") {
    if (trimmed.match(/\/v\d+$/)) {
      return `${trimmed}/messages`;
    }
    return `${trimmed}/v1/messages`;
  }
  return `${trimmed}${PROVIDER_CHAT_PATHS[provider]}`;
}

export function ChannelForm({ channel, onSaved, onCancel }: ChannelFormProps): React.ReactElement {
  const isEdit = channel !== null;

  const [name, setName] = useState(channel?.name ?? "");
  const [provider, setProvider] = useState<ProviderType>(channel?.provider ?? "anthropic");
  const [baseUrl, setBaseUrl] = useState(channel?.baseUrl ?? PROVIDER_DEFAULT_URLS.anthropic);
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [models, setModels] = useState<ChannelModel[]>(channel?.models ?? []);
  const [enabled, setEnabled] = useState(channel?.enabled ?? true);

  const [newModelId, setNewModelId] = useState("");
  const [newModelName, setNewModelName] = useState("");

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ChannelTestResult | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchResult, setFetchResult] = useState<FetchModelsResult | null>(null);
  const [apiKeyLoaded, setApiKeyLoaded] = useState(false);

  useEffect(() => {
    if (isEdit && channel && !apiKeyLoaded) {
      void decryptChannelApiKey(channel.id)
        .then((key) => {
          setApiKey(key);
          setApiKeyLoaded(true);
        })
        .catch((error) => {
          console.error("[ChannelForm] decrypt api key failed", error);
          setApiKeyLoaded(true);
        });
    }
  }, [isEdit, channel, apiKeyLoaded]);

  const handleProviderChange = (value: string): void => {
    const nextProvider = value as ProviderType;
    setProvider(nextProvider);
    setBaseUrl(PROVIDER_DEFAULT_URLS[nextProvider]);
    setTestResult(null);
  };

  const handleAddModel = (): void => {
    if (!newModelId.trim()) return;
    const model: ChannelModel = {
      id: newModelId.trim(),
      name: newModelName.trim() || newModelId.trim(),
      enabled: true
    };
    setModels((prev) => [...prev, model]);
    setNewModelId("");
    setNewModelName("");
  };

  const handleRemoveModel = (modelId: string): void => {
    setModels((prev) => prev.filter((model) => model.id !== modelId));
  };

  const handleToggleModel = (modelId: string): void => {
    setModels((prev) =>
      prev.map((model) => (model.id === modelId ? { ...model, enabled: !model.enabled } : model))
    );
  };

  const handleFetchModels = async (): Promise<void> => {
    if (!apiKey.trim() || !baseUrl.trim()) return;
    setFetchingModels(true);
    setFetchResult(null);
    try {
      const result = await fetchChannelModels({ provider, baseUrl, apiKey });
      setFetchResult(result);
      if (result.success && result.models.length > 0) {
        const existingIds = new Set(models.map((model) => model.id));
        const newModels = result.models
          .filter((model) => !existingIds.has(model.id))
          .map((model) => ({ ...model, enabled: false }));
        if (newModels.length > 0) {
          setModels((prev) => [...prev, ...newModels]);
        }
      }
    } catch {
      setFetchResult({ success: false, message: "拉取模型请求失败", models: [] });
    } finally {
      setFetchingModels(false);
    }
  };

  const handleTest = async (): Promise<void> => {
    if (!apiKey.trim() || !baseUrl.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testChannelDirect({ provider, baseUrl, apiKey });
      setTestResult(result);
    } catch {
      setTestResult({ success: false, message: "测试请求失败" });
    } finally {
      setTesting(false);
    }
  };

  const saveChannel = async (): Promise<void> => {
    if (isEdit && channel) {
      await updateChannel(channel.id, {
        name,
        provider,
        baseUrl,
        apiKey: apiKey || undefined,
        models,
        enabled
      });
      return;
    }

    const input: ChannelCreateInput = {
      name,
      provider,
      baseUrl,
      apiKey,
      models,
      enabled
    };
    await createChannel(input);
  };

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!name.trim() || !apiKey.trim()) return;
    setSaving(true);
    try {
      await saveChannel();
      onSaved();
    } catch (error) {
      console.error("[ChannelForm] save failed", error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="h-8 w-8" type="button" onClick={onCancel}>
          <ArrowLeft size={18} />
        </Button>
        <h3 className="flex-1 text-lg font-medium text-foreground">{isEdit ? "编辑渠道" : "添加渠道"}</h3>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" type="button" onClick={onCancel}>取消</Button>
          <Button size="sm" type="submit" disabled={saving || !name.trim() || (!isEdit && !apiKey.trim())}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            <span>{isEdit ? "保存修改" : "创建渠道"}</span>
          </Button>
        </div>
      </div>

      <SettingsSection title="基本信息">
        <SettingsCard>
          <SettingsInput
            label="渠道名称"
            value={name}
            onChange={setName}
            placeholder="例如: My Anthropic"
            required
          />
          <SettingsSelect
            label="供应商类型"
            value={provider}
            onValueChange={handleProviderChange}
            options={PROVIDER_SELECT_OPTIONS}
            placeholder="选择供应商"
          />
          <SettingsInput
            label="Base URL"
            value={baseUrl}
            onChange={setBaseUrl}
            placeholder="https://api.example.com"
            description={baseUrl.trim() ? `预览：${buildPreviewUrl(baseUrl, provider)}` : undefined}
          />

          <div className="space-y-2 px-4 py-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-foreground">API Key</div>
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => { void handleTest(); }}
                disabled={testing || !apiKey.trim() || !baseUrl.trim()}
                className="h-7 text-xs"
              >
                {testing ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
                <span>测试连接</span>
              </Button>
            </div>
            <div className="relative">
              <Input
                type={showApiKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={isEdit ? "留空则不更新" : "输入 API Key"}
                required={!isEdit}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowApiKey((prev) => !prev)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground transition-colors hover:text-foreground"
                tabIndex={-1}
              >
                {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {testResult ? (
              <div
                className={cn(
                  "flex items-center gap-1.5 text-xs",
                  testResult.success ? "text-emerald-600" : "text-destructive"
                )}
              >
                {testResult.success ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                <span>{testResult.message}</span>
              </div>
            ) : null}
          </div>

          <SettingsToggle
            label="启用此渠道"
            description="关闭后该渠道不会在模型选择中出现"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="模型列表"
        action={
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => { void handleFetchModels(); }}
            disabled={fetchingModels || !apiKey.trim() || !baseUrl.trim()}
            className="h-7 text-xs"
          >
            {fetchingModels ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            <span>从供应商获取</span>
          </Button>
        }
      >
        {fetchResult ? (
          <div
            className={cn(
              "flex items-center gap-1.5 px-1 text-xs",
              fetchResult.success ? "text-emerald-600" : "text-destructive"
            )}
          >
            {fetchResult.success ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
            <span>{fetchResult.message}</span>
          </div>
        ) : null}

        <SettingsCard divided={false}>
          <div className="divide-y divide-border/50">
            {models.map((model) => (
              <div key={model.id} className="flex items-center gap-2 px-4 py-2.5">
                <input
                  type="checkbox"
                  checked={model.enabled}
                  onChange={() => handleToggleModel(model.id)}
                  className="h-3.5 w-3.5 rounded border-input accent-foreground"
                />
                <span className="flex-1 text-sm text-foreground">
                  {model.name}
                  {model.name !== model.id ? <span className="ml-1 text-muted-foreground">({model.id})</span> : null}
                </span>
                <button
                  type="button"
                  onClick={() => handleRemoveModel(model.id)}
                  className="p-0.5 text-muted-foreground transition-colors hover:text-destructive"
                >
                  <X size={14} />
                </button>
              </div>
            ))}

            <div className="flex items-center gap-2 px-4 py-2.5">
              <Input
                value={newModelId}
                onChange={(e) => setNewModelId(e.target.value)}
                placeholder="模型 ID（如 claude-opus-4-6）"
                className="h-8 flex-1 text-sm"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddModel();
                  }
                }}
              />
              <Input
                value={newModelName}
                onChange={(e) => setNewModelName(e.target.value)}
                placeholder="显示名称（可选）"
                className="h-8 flex-1 text-sm"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddModel();
                  }
                }}
              />
              <Button
                variant="ghost"
                size="icon"
                type="button"
                onClick={handleAddModel}
                disabled={!newModelId.trim()}
                className="h-8 w-8 flex-shrink-0"
              >
                <Plus size={18} />
              </Button>
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>
    </form>
  );
}
