"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, Download, Loader2, Plus, X } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  decryptChannelApiKey,
  fetchChannelModels,
  testChannelDirect,
  updateChannel,
  createChannel
} from "@/lib/desktop-api";
import {
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSecretInput,
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

const PROVIDER_SELECT_OPTIONS = PROVIDER_OPTIONS.map((p) => ({
  value: p,
  label: PROVIDER_LABELS[p]
}));

export function ChannelForm({ channel, onSaved, onCancel }: ChannelFormProps): React.ReactElement {
  const isEdit = channel !== null;
  const [name, setName] = useState(channel?.name ?? "");
  const [provider, setProvider] = useState<ProviderType>(channel?.provider ?? "anthropic");
  const [baseUrl, setBaseUrl] = useState(channel?.baseUrl ?? PROVIDER_DEFAULT_URLS.anthropic);
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<ChannelModel[]>(channel?.models ?? []);
  const [enabled, setEnabled] = useState(channel?.enabled ?? true);

  const [newModelId, setNewModelId] = useState("");
  const [newModelName, setNewModelName] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [testResult, setTestResult] = useState<ChannelTestResult | null>(null);
  const [fetchResult, setFetchResult] = useState<FetchModelsResult | null>(null);

  useEffect(() => {
    if (!isEdit || !channel) return;
    void decryptChannelApiKey(channel.id)
      .then(setApiKey)
      .catch(() => undefined);
  }, [isEdit, channel]);

  const onProviderChange = (value: string): void => {
    const next = value as ProviderType;
    setProvider(next);
    setBaseUrl(PROVIDER_DEFAULT_URLS[next]);
    setTestResult(null);
    setFetchResult(null);
  };

  const addModel = (): void => {
    const id = newModelId.trim();
    if (!id) return;
    if (models.some((m) => m.id === id)) return;
    setModels((prev) => [
      ...prev,
      {
        id,
        name: newModelName.trim() || id,
        enabled: true
      }
    ]);
    setNewModelId("");
    setNewModelName("");
  };

  const save = async (): Promise<void> => {
    if (isEdit && channel) {
      await updateChannel(channel.id, {
        name,
        provider,
        baseUrl,
        apiKey: apiKey.trim() || undefined,
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
    if (!name.trim()) return;
    if (!isEdit && !apiKey.trim()) return;
    setSaving(true);
    try {
      await save();
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
        <h3 className="flex-1 text-lg font-semibold">{isEdit ? "编辑渠道" : "添加渠道"}</h3>
        <div className="flex items-center gap-1.5">
          <Button type="button" variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button type="submit" disabled={saving || !name.trim() || (!isEdit && !apiKey.trim())}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            {isEdit ? "保存修改" : "创建渠道"}
          </Button>
        </div>
      </div>

      <SettingsSection title="基本信息">
        <SettingsCard>
          <SettingsInput label="渠道名称" value={name} onChange={setName} required />
          <SettingsSelect
            label="供应商"
            value={provider}
            onValueChange={onProviderChange}
            options={PROVIDER_SELECT_OPTIONS}
          />
          <SettingsInput label="Base URL" value={baseUrl} onChange={setBaseUrl} />
          <div className="flex flex-col gap-1.5 px-1 py-1">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold text-slate-200">API Key</span>
              <Button
                type="button"
                variant="outline"
                onClick={async () => {
                  if (!apiKey.trim() || !baseUrl.trim()) return;
                  setTesting(true);
                  try {
                    setTestResult(await testChannelDirect({ provider, baseUrl, apiKey }));
                  } finally {
                    setTesting(false);
                  }
                }}
                disabled={testing || !apiKey.trim() || !baseUrl.trim()}
              >
                {testing ? <Loader2 size={14} className="animate-spin" /> : "测试连接"}
              </Button>
            </div>
            <SettingsSecretInput
              label=""
              value={apiKey}
              onChange={setApiKey}
              placeholder={isEdit ? "留空则不更新" : "输入 API Key"}
              required={!isEdit}
            />
            {testResult ? <div className="text-xs text-muted-foreground">{testResult.message}</div> : null}
          </div>
          <SettingsToggle label="启用此渠道" checked={enabled} onCheckedChange={setEnabled} />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="模型列表"
        action={
          <Button
            type="button"
            variant="outline"
            onClick={async () => {
              if (!apiKey.trim() || !baseUrl.trim()) return;
              setFetchingModels(true);
              try {
                const result = await fetchChannelModels({ provider, baseUrl, apiKey });
                setFetchResult(result);
                if (result.success) {
                  const known = new Set(models.map((m) => m.id));
                  const incoming = result.models.filter((m) => !known.has(m.id)).map((m) => ({ ...m, enabled: false }));
                  if (incoming.length > 0) {
                    setModels((prev) => [...prev, ...incoming]);
                  }
                }
              } finally {
                setFetchingModels(false);
              }
            }}
            disabled={fetchingModels || !apiKey.trim() || !baseUrl.trim()}
          >
            {fetchingModels ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            从供应商获取
          </Button>
        }
      >
        <SettingsCard divided={false}>
          <div className="flex flex-col gap-2">
            {models.map((model) => (
              <div key={model.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-md border border-slate-700 bg-slate-900/40 px-2 py-1.5">
                <input
                  type="checkbox"
                  checked={model.enabled}
                  onChange={() =>
                    setModels((prev) =>
                      prev.map((m) => (m.id === model.id ? { ...m, enabled: !m.enabled } : m))
                    )
                  }
                />
                <span className="truncate text-xs">{model.id}</span>
                <button
                  type="button"
                  className="rounded border border-red-900 bg-red-950/30 px-1.5 py-1 text-red-300 hover:bg-red-900/40"
                  onClick={() => setModels((prev) => prev.filter((m) => m.id !== model.id))}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            <div className="grid grid-cols-1 gap-2 lg:grid-cols-[1fr_1fr_auto]">
              <Input className="border-slate-700 bg-slate-950" value={newModelId} placeholder="model id" onChange={(event) => setNewModelId(event.target.value)} />
              <Input className="border-slate-700 bg-slate-950" value={newModelName} placeholder="display name" onChange={(event) => setNewModelName(event.target.value)} />
              <Button type="button" onClick={addModel}>
                <Plus size={14} />
                添加
              </Button>
            </div>
            {fetchResult ? <p className="text-xs text-muted-foreground">{fetchResult.message}</p> : null}
          </div>
        </SettingsCard>
      </SettingsSection>
    </form>
  );
}
