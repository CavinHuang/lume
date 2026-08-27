export type ImProvider = "weixin" | "dingtalk" | "feishu" | "wecom";

export type ImAccountStatus = "stopped" | "starting" | "running" | "error" | "auth_required";

export type ImPeerKind = "dm" | "group";

export interface ImAccount {
  id: string;
  provider: ImProvider;
  accountKey?: string;
  label: string;
  uin?: string;
  workspaceId?: string;
  baseUrl: string;
  enabled: boolean;
  status: ImAccountStatus;
  hasToken: boolean;
  cursor?: string;
  contextToken?: string;
  /** #544 会话镜像：该账号最近一次 DM 互动的发送者 id，反向建镜像群的目标用户来源（sidecar 内部维护） */
  lastInteractedSenderId?: string;
  lastError?: string;
  lastStartedAt?: number;
  lastStoppedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ImAccountCreateInput {
  provider: ImProvider;
  accountKey?: string;
  label?: string;
  token: string;
  uin?: string;
  workspaceId?: string;
  baseUrl?: string;
  enabled?: boolean;
}

export interface ImAccountUpdateInput {
  accountKey?: string;
  label?: string;
  token?: string;
  uin?: string;
  workspaceId?: string;
  baseUrl?: string;
  enabled?: boolean;
  status?: ImAccountStatus;
  cursor?: string;
  contextToken?: string;
  lastError?: string | null;
  lastStartedAt?: number;
  lastStoppedAt?: number;
}

export interface ImThreadBinding {
  key: string;
  provider: ImProvider;
  accountId: string;
  peerKind: ImPeerKind;
  peerId: string;
  peerName?: string;
  threadId: string;
  contextToken?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ImPeerRef {
  provider: ImProvider;
  accountId: string;
  peerKind: ImPeerKind;
  peerId: string;
}

export type ImWeixinLoginStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

export interface ImWeixinLoginStartInput {
  force?: boolean;
  workspaceId?: string;
}

export interface ImWeixinLoginStartResult {
  sessionKey: string;
  qrcodeUrl?: string;
  qrcodeImageSrc?: string;
  message: string;
  expiresAt: number;
}

export interface ImWeixinLoginPollInput {
  sessionKey: string;
  verifyCode?: string;
}

export interface ImWeixinLoginPollResult {
  connected: boolean;
  alreadyConnected?: boolean;
  status?: ImWeixinLoginStatus;
  needsVerifyCode?: boolean;
  message: string;
  account?: ImAccount;
}

// ─── CLI Auth (企业渠道 OAuth 授权,provider 级) ───

export type CliAuthPhase = "authorizing" | "connected" | "error";

export interface CliAuthStartInput {
  provider: ImProvider;
}

export interface CliAuthStartResult {
  sessionKey: string;
  authUrl?: string;
  error?: string;
}

export interface CliAuthPollInput {
  sessionKey: string;
}

export interface CliAuthPollResult {
  phase: CliAuthPhase;
  authUrl?: string;
  profile?: string;
  error?: string;
}

export const IM_IPC_CHANNELS = {
  LIST_ACCOUNTS: "im:list-accounts",
  CREATE_ACCOUNT: "im:create-account",
  UPDATE_ACCOUNT: "im:update-account",
  DELETE_ACCOUNT: "im:delete-account",
  START_ACCOUNT: "im:start-account",
  STOP_ACCOUNT: "im:stop-account",
  START_WEIXIN_LOGIN: "im:start-weixin-login",
  POLL_WEIXIN_LOGIN: "im:poll-weixin-login",
  START_CLI_AUTH: "im:start-cli-auth",
  POLL_CLI_AUTH: "im:poll-cli-auth",
  CANCEL_CLI_AUTH: "im:cancel-cli-auth",
  // #544 会话镜像
  MIRROR_GET_SETTINGS: "im-mirror:get-settings",
  MIRROR_SET_OWNER: "im-mirror:set-owner",
  MIRROR_LIST: "im-mirror:list",
  MIRROR_ATTACH_CANDIDATES: "im-mirror:attach-candidates",
  MIRROR_ATTACH: "im-mirror:attach",
  MIRROR_DETACH: "im-mirror:detach",
  /** 保活通知（sidecar→desktop main 单向推送，NOTIFY_ONLY 显式登记） */
  MIRROR_STREAM_ACTIVE: "im-mirror:stream-active"
} as const;

export const IM_PROVIDER_LABELS: Record<ImProvider, string> = {
  weixin: "微信",
  dingtalk: "钉钉",
  feishu: "飞书",
  wecom: "企业微信",
};

export function normalizeImAccountLabel(input: {
  provider: ImProvider;
  label?: string | null;
  uin?: string | null;
}): string {
  const label = input.label?.trim();
  if (label) return label;
  const providerLabel = IM_PROVIDER_LABELS[input.provider];
  const uin = input.uin?.trim();
  return uin ? `${providerLabel} ${uin}` : providerLabel;
}

// ─── Multimedia Content Types ───

export type ImMessageContent =
  | ImTextContent
  | ImImageContent
  | ImVoiceContent
  | ImFileContent
  | ImVideoContent;

export interface ImTextContent {
  type: "text";
  text: string;
}

export interface ImImageContent {
  type: "image";
  /** Directly accessible image URL (downloaded from CDN or direct link) */
  url: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  /** CDN aes_key (base64) when the media is AES-128-ECB encrypted; consumed by the media resolver to decrypt. */
  aesKey?: string;
}

export interface ImVoiceContent {
  type: "voice";
  /** Speech-to-text result from WeChat */
  text?: string;
  /** Duration in milliseconds */
  playtime?: number;
}

export interface ImFileContent {
  type: "file";
  fileName: string;
  fileSize: number;
  md5?: string;
  downloadUrl?: string;
  /** CDN aes_key (base64) when the media is AES-128-ECB encrypted; consumed by the media resolver to decrypt. */
  aesKey?: string;
}

export interface ImVideoContent {
  type: "video";
  thumbnailUrl?: string;
  playLength?: number;
  fileSize?: number;
}

// ─── 会话镜像（#544）：桌面线程 ↔ IM 群双向同步 ───

/** 运行进度落到 IM 群的载体形态：card=可编辑卡片（飞书 cardkit），text=两段式文本播报 */
export type ImMirrorCarrier = "card" | "text";

export type ImMirrorTier = "full" | "attach" | "unsupported";

export interface ImMirrorTierInfo {
  tier: ImMirrorTier;
  /** unsupported 档的原因说明（设置页灰置文案） */
  reason?: string;
}

/**
 * 各渠道镜像能力分档（编译期事实，UI 直接消费不付 RPC）。
 * full=建群/改名/退群+流式卡片全栈；attach=附着已有群+文本档；
 * unsupported=transport 无法主动外发（钉钉出站依赖入站 event 附带的 sessionWebhook）。
 */
export const IM_MIRROR_TIERS: Record<ImProvider, ImMirrorTierInfo> = {
  feishu: { tier: "full" },
  weixin: { tier: "attach" },
  dingtalk: { tier: "unsupported", reason: "钉钉机器人仅能回复收到的消息，无法主动向群推送运行过程" },
  wecom: { tier: "unsupported", reason: "企业微信通道暂不支持主动向群推送运行过程" }
};

export interface ImMirrorEntryPublic {
  threadId: string;
  accountId: string;
  chatId: string;
  carrier: ImMirrorCarrier;
  createdAt: number;
  lastError?: string;
}

export interface ImMirrorSettingsPublic {
  enabledMirrorAccountId: string | null;
  lastError?: string;
}

/** 保活通知载荷（sidecar→desktop main）：按 threadId 引用计数 powerSaveBlocker */
export interface ImMirrorStreamActivity {
  threadId: string;
  active: boolean;
}

/** attach 附着候选：机器人已在的群（来自该账号的 group binding） */
export interface ImMirrorAttachCandidate {
  peerId: string;
  peerName?: string;
  threadId: string;
}
