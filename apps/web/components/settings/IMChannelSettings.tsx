"use client";

import { useEffect, useState } from "react";
import type {
  ChannelDeliveryRecord,
  ChannelGatewayIngressStatus,
  ChannelProvider,
  ChannelSessionBinding,
  FeishuConnectionMode,
  FeishuGatewayConfigView
} from "@lume/shared";
import { useAtomValue } from "jotai";
import { currentAgentWorkspaceIdAtom } from "@/atoms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getFeishuGatewayConfig,
  getChannelGatewayIngressStatus,
  listChannelGatewayBindings,
  listChannelGatewayDeliveries,
  saveFeishuGatewayConfig,
  simulateChannelGatewayIngress,
  startChannelGatewayIngress,
  stopChannelGatewayIngress,
  testFeishuGatewayConfig
} from "@/lib/desktop-api";
import {
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSecretInput,
  SettingsSection,
  SettingsSegmentedControl,
  SettingsSelect,
  SettingsToggle
} from "./primitives";

const CHANNEL_PROVIDER_OPTIONS: ChannelProvider[] = ["feishu", "telegram", "discord", "whatsapp", "slack"];

const CONNECTION_MODE_OPTIONS = [
  { value: "websocket", label: "WebSocket 长连接" },
  { value: "webhook", label: "Webhook 回调" }
];

const DOMAIN_OPTIONS = [
  { value: "feishu", label: "飞书 (feishu)" },
  { value: "lark", label: "Lark (国际版)" }
];

export function IMChannelSettings(): React.ReactElement {
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom);

  const [channelGatewayBindings, setChannelGatewayBindings] = useState<ChannelSessionBinding[]>([]);
  const [channelGatewayDeliveries, setChannelGatewayDeliveries] = useState<ChannelDeliveryRecord[]>([]);
  const [channelGatewayLoading, setChannelGatewayLoading] = useState(false);
  const [channelGatewayBusy, setChannelGatewayBusy] = useState(false);
  const [channelGatewayMessage, setChannelGatewayMessage] = useState("");
  const [channelGatewayProvider, setChannelGatewayProvider] = useState<ChannelProvider>("feishu");
  const [channelGatewayExternalChatId, setChannelGatewayExternalChatId] = useState("");
  const [channelGatewayExternalUserId, setChannelGatewayExternalUserId] = useState("");
  const [channelGatewayInboundText, setChannelGatewayInboundText] = useState("");
  const [channelGatewayIngressStatus, setChannelGatewayIngressStatus] = useState<ChannelGatewayIngressStatus | null>(null);
  const [feishuConfig, setFeishuConfig] = useState<FeishuGatewayConfigView | null>(null);
  const [feishuEnabled, setFeishuEnabled] = useState(false);
  const [feishuConnectionMode, setFeishuConnectionMode] = useState<FeishuConnectionMode>("websocket");
  const [feishuAppId, setFeishuAppId] = useState("");
  const [feishuAppSecret, setFeishuAppSecret] = useState("");
  const [feishuVerificationToken, setFeishuVerificationToken] = useState("");
  const [feishuEncryptKey, setFeishuEncryptKey] = useState("");
  const [feishuDomain, setFeishuDomain] = useState<"feishu" | "lark">("feishu");
  const [feishuWebhookPath, setFeishuWebhookPath] = useState("/webhook/feishu");
  const [feishuDefaultWorkspaceId, setFeishuDefaultWorkspaceId] = useState("");

  const isWebSocketMode = feishuConnectionMode === "websocket";

  const loadChannelGatewayData = async (): Promise<void> => {
    setChannelGatewayLoading(true);
    try {
      const [bindings, deliveries] = await Promise.all([
        listChannelGatewayBindings(),
        listChannelGatewayDeliveries({ limit: 20 })
      ]);
      setChannelGatewayBindings(bindings);
      setChannelGatewayDeliveries(deliveries);
      const [ingressStatus, config] = await Promise.all([
        getChannelGatewayIngressStatus(),
        getFeishuGatewayConfig()
      ]);
      setChannelGatewayIngressStatus(ingressStatus);
      setFeishuConfig(config);
      setFeishuEnabled(config.enabled);
      setFeishuConnectionMode(config.connectionMode);
      setFeishuAppId(config.appId);
      setFeishuDomain(config.domain);
      setFeishuWebhookPath(config.webhookPath);
      setFeishuDefaultWorkspaceId(config.defaultWorkspaceId ?? "");
    } catch (error) {
      console.error("[IMChannelSettings] load channel gateway data failed", error);
      setChannelGatewayMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setChannelGatewayLoading(false);
    }
  };

  useEffect(() => {
    void loadChannelGatewayData();
  }, []);

  const handleSimulateChannelGatewayIngress = async (): Promise<void> => {
    if (!channelGatewayExternalChatId.trim() || !channelGatewayInboundText.trim()) {
      setChannelGatewayMessage("渠道会话ID和入站文本不能为空");
      return;
    }
    setChannelGatewayBusy(true);
    setChannelGatewayMessage("");
    try {
      const now = Date.now();
      const result = await simulateChannelGatewayIngress({
        event: {
          id: `sim-event-${crypto.randomUUID()}`,
          provider: channelGatewayProvider,
          externalChatId: channelGatewayExternalChatId.trim(),
          externalUserId: channelGatewayExternalUserId.trim() || undefined,
          externalMessageId: `sim-msg-${now}`,
          text: channelGatewayInboundText.trim(),
          receivedAt: now,
          workspaceId: currentWorkspaceId ?? undefined
        }
      });
      if (result.duplicate) {
        setChannelGatewayMessage("已忽略重复消息");
      } else if (result.accepted) {
        setChannelGatewayMessage(`模拟入站成功，session: ${result.binding?.sessionId ?? "unknown"}`);
      } else {
        setChannelGatewayMessage(`模拟入站失败: ${result.error ?? "unknown error"}`);
      }
      await loadChannelGatewayData();
    } catch (error) {
      setChannelGatewayMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setChannelGatewayBusy(false);
    }
  };

  const handleStartChannelGatewayIngress = async (): Promise<void> => {
    setChannelGatewayBusy(true);
    setChannelGatewayMessage("");
    try {
      const status = await startChannelGatewayIngress();
      setChannelGatewayIngressStatus(status);
      if (status.connectionMode === "websocket") {
        setChannelGatewayMessage(`飞书 WebSocket 长连接已启动: 连接=${status.wsConnected ? "是" : "否"}`);
      } else {
        setChannelGatewayMessage(`飞书 Webhook 服务已启动: ${status.webhookUrl ?? "unknown"}`);
      }
    } catch (error) {
      setChannelGatewayMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setChannelGatewayBusy(false);
    }
  };

  const handleStopChannelGatewayIngress = async (): Promise<void> => {
    setChannelGatewayBusy(true);
    setChannelGatewayMessage("");
    try {
      await stopChannelGatewayIngress();
      const status = await getChannelGatewayIngressStatus();
      setChannelGatewayIngressStatus(status);
      setChannelGatewayMessage("飞书服务已停止");
    } catch (error) {
      setChannelGatewayMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setChannelGatewayBusy(false);
    }
  };

  const handleSaveFeishuConfig = async (): Promise<void> => {
    setChannelGatewayBusy(true);
    setChannelGatewayMessage("");
    try {
      const saved = await saveFeishuGatewayConfig({
        enabled: feishuEnabled,
        connectionMode: feishuConnectionMode,
        appId: feishuAppId.trim(),
        ...(feishuAppSecret.trim() ? { appSecret: feishuAppSecret.trim() } : {}),
        ...(feishuVerificationToken.trim() ? { verificationToken: feishuVerificationToken.trim() } : {}),
        ...(feishuEncryptKey.trim() ? { encryptKey: feishuEncryptKey.trim() } : {}),
        domain: feishuDomain,
        defaultWorkspaceId: feishuDefaultWorkspaceId.trim() || undefined,
        webhookPath: feishuWebhookPath.trim()
      });
      setFeishuConfig(saved);
      setFeishuAppSecret("");
      setFeishuVerificationToken("");
      setFeishuEncryptKey("");
      setChannelGatewayMessage("飞书配置已保存");
      await loadChannelGatewayData();
    } catch (error) {
      setChannelGatewayMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setChannelGatewayBusy(false);
    }
  };

  const handleTestFeishuConfig = async (): Promise<void> => {
    setChannelGatewayBusy(true);
    setChannelGatewayMessage("");
    try {
      const result = await testFeishuGatewayConfig();
      setChannelGatewayMessage(
        result.success
          ? `连通成功: ${result.message}${result.botOpenId ? ` · bot=${result.botOpenId}` : ""}`
          : `连通失败: ${result.message}`
      );
    } catch (error) {
      setChannelGatewayMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setChannelGatewayBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* ── 飞书网关配置 ── */}
      <SettingsSection title="飞书网关" description="配置飞书应用凭证和接入方式">
        <SettingsCard>
          <SettingsToggle
            label="启用飞书网关"
            description="开启后可接收和发送飞书消息"
            checked={feishuEnabled}
            onCheckedChange={setFeishuEnabled}
          />
          <SettingsSegmentedControl
            label="接入方式"
            description={isWebSocketMode
              ? "通过 WebSocket 长连接接收消息，无需公网 IP 和内网穿透"
              : "通过 HTTP 回调接收消息，需要公网可达地址"
            }
            value={feishuConnectionMode}
            onValueChange={(v) => setFeishuConnectionMode(v as FeishuConnectionMode)}
            options={CONNECTION_MODE_OPTIONS}
          />
          <SettingsSelect
            label="平台"
            value={feishuDomain}
            onValueChange={(v) => setFeishuDomain(v as "feishu" | "lark")}
            options={DOMAIN_OPTIONS}
          />
        </SettingsCard>
      </SettingsSection>

      {/* ── 应用凭证 ── */}
      <SettingsSection title="应用凭证" description="在飞书开发者后台 > 应用凭证中获取">
        <SettingsCard>
          <SettingsInput
            label="App ID"
            value={feishuAppId}
            onChange={setFeishuAppId}
            placeholder="例如: cli_xxx"
          />
          <SettingsSecretInput
            label="App Secret"
            value={feishuAppSecret}
            onChange={setFeishuAppSecret}
            placeholder={feishuConfig?.hasAppSecret ? "已配置（留空保持不变）" : "输入 App Secret"}
          />
          {!isWebSocketMode && (
            <>
              <SettingsSecretInput
                label="Verification Token"
                description="Webhook 模式必填，用于验证请求来源"
                value={feishuVerificationToken}
                onChange={setFeishuVerificationToken}
                placeholder={feishuConfig?.hasVerificationToken ? "已配置（留空保持不变）" : "输入 Verification Token"}
              />
              <SettingsSecretInput
                label="Encrypt Key"
                description="可选，用于解密飞书加密消息"
                value={feishuEncryptKey}
                onChange={setFeishuEncryptKey}
                placeholder={feishuConfig?.hasEncryptKey ? "已配置（留空保持不变）" : "输入 Encrypt Key（可选）"}
              />
              <SettingsInput
                label="Webhook 路径"
                value={feishuWebhookPath}
                onChange={setFeishuWebhookPath}
                placeholder="/webhook/feishu"
              />
            </>
          )}
          <SettingsInput
            label="默认 Workspace ID"
            description="可选，将飞书消息绑定到指定工作区"
            value={feishuDefaultWorkspaceId}
            onChange={setFeishuDefaultWorkspaceId}
            placeholder="留空使用默认工作区"
          />
          <div className="flex justify-end gap-2 px-4 py-3">
            <Button size="sm" type="button" variant="outline" disabled={channelGatewayBusy} onClick={() => { void handleTestFeishuConfig(); }}>
              测试连接
            </Button>
            <Button size="sm" type="button" disabled={channelGatewayBusy} onClick={() => { void handleSaveFeishuConfig(); }}>
              保存配置
            </Button>
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* ── 接入服务 ── */}
      <SettingsSection
        title="接入服务"
        description={isWebSocketMode
          ? "管理 WebSocket 长连接状态"
          : "管理 Webhook HTTP 服务状态"
        }
      >
        <SettingsCard divided={false}>
          <div className="px-4 py-3 space-y-3">
            <div className="rounded-md border bg-muted/20 p-3 space-y-2">
              {isWebSocketMode ? (
                <div className="flex items-center gap-2 text-sm">
                  <span className={`inline-block size-2 rounded-full ${channelGatewayIngressStatus?.wsConnected ? "bg-green-500" : "bg-muted-foreground/40"}`} />
                  <span className="text-muted-foreground">
                    {channelGatewayIngressStatus?.running
                      ? (channelGatewayIngressStatus.wsConnected ? "已连接" : "连接中...")
                      : "未启动"
                    }
                  </span>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-sm">
                    <span className={`inline-block size-2 rounded-full ${channelGatewayIngressStatus?.running ? "bg-green-500" : "bg-muted-foreground/40"}`} />
                    <span className="text-muted-foreground">
                      {channelGatewayIngressStatus?.running
                        ? `运行中 · 端口 ${channelGatewayIngressStatus.port ?? "-"}`
                        : "未启动"
                      }
                    </span>
                  </div>
                  {channelGatewayIngressStatus?.webhookUrl && (
                    <p className="break-all font-mono text-xs text-muted-foreground">
                      {channelGatewayIngressStatus.webhookUrl}
                    </p>
                  )}
                </>
              )}
              <div className="flex gap-2">
                <Button size="sm" type="button" disabled={channelGatewayBusy} onClick={() => { void handleStartChannelGatewayIngress(); }}>
                  {channelGatewayIngressStatus?.running ? "重新连接" : (isWebSocketMode ? "启动连接" : "启动服务")}
                </Button>
                {channelGatewayIngressStatus?.running && (
                  <Button size="sm" type="button" variant="secondary" disabled={channelGatewayBusy} onClick={() => { void handleStopChannelGatewayIngress(); }}>
                    停止
                  </Button>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {isWebSocketMode
                ? "飞书开发者后台 > 事件订阅 > 订阅方式选择「长连接」，添加事件 im.message.receive_v1。"
                : "飞书事件订阅地址填写上方 URL，事件选择 im.message.receive_v1。本地调试需配合内网穿透。"
              }
            </p>
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* ── 模拟入站调试 ── */}
      <SettingsSection title="模拟入站" description="模拟外部渠道消息入站，验证网关链路">
        <SettingsCard divided={false}>
          <div className="px-4 py-3 space-y-3">
            <div className="grid gap-2">
              <SettingsSelect
                label="渠道"
                value={channelGatewayProvider}
                onValueChange={(v) => setChannelGatewayProvider(v as ChannelProvider)}
                options={CHANNEL_PROVIDER_OPTIONS.map((p) => ({ value: p, label: p }))}
              />
              <SettingsInput
                label="外部会话 ID"
                value={channelGatewayExternalChatId}
                onChange={setChannelGatewayExternalChatId}
                placeholder="例如: tg_chat_123"
              />
              <SettingsInput
                label="外部用户 ID"
                description="可选"
                value={channelGatewayExternalUserId}
                onChange={setChannelGatewayExternalUserId}
                placeholder="发送者 ID"
              />
              <div className="px-4 py-3 space-y-2">
                <div className="text-sm font-medium leading-none">入站文本</div>
                <textarea
                  value={channelGatewayInboundText}
                  onChange={(event) => setChannelGatewayInboundText(event.target.value)}
                  placeholder="例如：请总结今天工作进度"
                  rows={3}
                  className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 px-4">
              <Button size="sm" type="button" variant="outline" disabled={channelGatewayBusy} onClick={() => { void loadChannelGatewayData(); }}>
                刷新
              </Button>
              <Button size="sm" type="button" disabled={channelGatewayBusy} onClick={() => { void handleSimulateChannelGatewayIngress(); }}>
                模拟入站
              </Button>
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* ── 会话绑定与投递记录 ── */}
      <SettingsSection title="会话绑定与投递记录" description="外部渠道会话与 Agent Session 的绑定关系和消息投递状态">
        <SettingsCard divided={false}>
          <div className="px-4 py-3 space-y-3">
            <div className="rounded-md border bg-muted/20 p-3">
              <p className="text-sm font-medium">会话绑定</p>
              {channelGatewayLoading ? (
                <p className="mt-2 text-xs text-muted-foreground">加载中...</p>
              ) : channelGatewayBindings.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">暂无绑定</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {channelGatewayBindings.slice(0, 8).map((binding) => (
                    <div key={binding.id} className="rounded-md border bg-background/80 p-2">
                      <p className="text-xs font-medium">{binding.provider} · {binding.externalChatId}</p>
                      <p className="text-xs text-muted-foreground">session: {binding.sessionId}</p>
                      <p className="text-xs text-muted-foreground">更新: {new Date(binding.updatedAt).toLocaleString()}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="rounded-md border bg-muted/20 p-3">
              <p className="text-sm font-medium">最近投递</p>
              {channelGatewayLoading ? (
                <p className="mt-2 text-xs text-muted-foreground">加载中...</p>
              ) : channelGatewayDeliveries.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">暂无记录</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {channelGatewayDeliveries.slice(0, 8).map((delivery) => (
                    <div key={delivery.id} className="rounded-md border bg-background/80 p-2">
                      <p className="text-xs font-medium">{delivery.provider} · {delivery.status}</p>
                      <p className="text-xs text-muted-foreground">outbound: {delivery.outboundMessageId}</p>
                      <p className="text-xs text-muted-foreground">尝试: {delivery.attempts} · {new Date(delivery.updatedAt).toLocaleString()}</p>
                      {delivery.error ? <p className="mt-1 text-xs text-amber-700">{delivery.error}</p> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
            {channelGatewayMessage ? <p className="text-xs text-foreground">{channelGatewayMessage}</p> : null}
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
