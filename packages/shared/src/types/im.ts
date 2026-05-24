export type ImProvider = "weixin";

export type ImAccountStatus = "stopped" | "starting" | "running" | "error" | "auth_required";

export type ImPeerKind = "dm" | "group";

export interface ImAccount {
  id: string;
  provider: ImProvider;
  label: string;
  uin?: string;
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
  label?: string;
  token: string;
  uin?: string;
  baseUrl?: string;
  enabled?: boolean;
}

export interface ImAccountUpdateInput {
  label?: string;
  token?: string;
  uin?: string;
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

export const IM_IPC_CHANNELS = {
  LIST_ACCOUNTS: "im:list-accounts",
  CREATE_ACCOUNT: "im:create-account",
  UPDATE_ACCOUNT: "im:update-account",
  DELETE_ACCOUNT: "im:delete-account",
  START_ACCOUNT: "im:start-account",
  STOP_ACCOUNT: "im:stop-account"
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
