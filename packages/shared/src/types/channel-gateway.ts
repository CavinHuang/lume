/**
 * Channel Gateway 相关类型定义
 */

export type ChannelProvider = "telegram" | "discord" | "whatsapp" | "slack" | "feishu";

export interface ChannelInboundEvent {
  id: string;
  provider: ChannelProvider;
  externalChatId: string;
  externalUserId?: string;
  externalMessageId: string;
  text: string;
  receivedAt: number;
  workspaceId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface ChannelOutboundMessage {
  id: string;
  provider: ChannelProvider;
  externalChatId: string;
  text: string;
  inReplyToEventId?: string;
  workspaceId?: string;
  sessionId?: string;
  createdAt: number;
}

export interface ChannelSessionBinding {
  id: string;
  provider: ChannelProvider;
  externalChatId: string;
  externalUserId?: string;
  workspaceId?: string;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
}

export type ChannelDeliveryStatus = "pending" | "sent" | "failed";

export interface ChannelDeliveryRecord {
  id: string;
  provider: ChannelProvider;
  outboundMessageId: string;
  status: ChannelDeliveryStatus;
  attempts: number;
  externalMessageId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChannelRetryItem {
  id: string;
  provider: ChannelProvider;
  outboundMessageId: string;
  reason: string;
  externalChatId?: string;
  text?: string;
  replyToMessageId?: string;
  retryAt: number;
  attempts: number;
  createdAt: number;
}

export interface ChannelGatewayIngressInput {
  event: ChannelInboundEvent;
}

export interface ChannelGatewayIngressResult {
  accepted: boolean;
  duplicate: boolean;
  binding?: ChannelSessionBinding;
  outbound?: ChannelOutboundMessage;
  delivery?: ChannelDeliveryRecord;
  error?: string;
}

export interface ChannelGatewayListDeliveriesInput {
  provider?: ChannelProvider;
  limit?: number;
}

export interface ChannelGatewayIngressStatus {
  running: boolean;
  port: number | null;
  webhookPath: string;
  webhookUrl: string | null;
}

export interface FeishuGatewayConfig {
  version: number;
  enabled: boolean;
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey?: string;
  domain: "feishu" | "lark";
  defaultWorkspaceId?: string;
  webhookPath: string;
}

export interface FeishuGatewayConfigView {
  version: number;
  enabled: boolean;
  appId: string;
  hasAppSecret: boolean;
  hasVerificationToken: boolean;
  hasEncryptKey: boolean;
  domain: "feishu" | "lark";
  defaultWorkspaceId?: string;
  webhookPath: string;
}

export interface FeishuGatewayConfigInput {
  enabled: boolean;
  appId: string;
  appSecret?: string;
  verificationToken?: string;
  encryptKey?: string;
  domain?: "feishu" | "lark";
  defaultWorkspaceId?: string;
  webhookPath?: string;
}

export interface FeishuGatewayTestResult {
  success: boolean;
  message: string;
  botOpenId?: string;
  tenantName?: string;
}

export const CHANNEL_GATEWAY_IPC_CHANNELS = {
  SIMULATE_INGRESS: "channel-gateway:simulate-ingress",
  LIST_BINDINGS: "channel-gateway:list-bindings",
  UPSERT_BINDING: "channel-gateway:upsert-binding",
  LIST_DELIVERIES: "channel-gateway:list-deliveries",
  GET_INGRESS_STATUS: "channel-gateway:get-ingress-status",
  START_INGRESS: "channel-gateway:start-ingress",
  STOP_INGRESS: "channel-gateway:stop-ingress",
  GET_FEISHU_CONFIG: "channel-gateway:get-feishu-config",
  SAVE_FEISHU_CONFIG: "channel-gateway:save-feishu-config",
  TEST_FEISHU_CONFIG: "channel-gateway:test-feishu-config"
} as const;
