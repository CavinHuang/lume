export type ImProvider = "weixin";

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

export const IM_IPC_CHANNELS = {
  LIST_ACCOUNTS: "im:list-accounts",
  CREATE_ACCOUNT: "im:create-account",
  UPDATE_ACCOUNT: "im:update-account",
  DELETE_ACCOUNT: "im:delete-account",
  START_ACCOUNT: "im:start-account",
  STOP_ACCOUNT: "im:stop-account",
  START_WEIXIN_LOGIN: "im:start-weixin-login",
  POLL_WEIXIN_LOGIN: "im:poll-weixin-login"
} as const;

export const IM_PROVIDER_LABELS: Record<ImProvider, string> = {
  weixin: "Weixin"
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
