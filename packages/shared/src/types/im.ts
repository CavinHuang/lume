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
  CANCEL_CLI_AUTH: "im:cancel-cli-auth"
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
