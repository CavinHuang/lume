export type LinkRuntimePhase = "disabled" | "starting" | "online" | "stopping" | "offline" | "crashed" | "port_conflict" | "incompatible";

export interface LinkRuntimeState {
  enabled: boolean;
  phase: LinkRuntimePhase;
  port: number | null;
  origin: string | null;
  version: string;
  dataDirectory: string;
  restartCount: number;
  lastError?: string;
}

export interface LinkRuntimeDiagnostic {
  checkedAt: string;
  runtimePhase: LinkRuntimePhase;
  resourceReady: boolean;
  dataDirectoryReady: boolean;
  endpointReachable: boolean;
  latencyMs?: number;
  error?: string;
}

export interface LinkProviderSummary {
  service: string;
  displayName: string;
  description?: string;
  categories: string[];
  authTypes: string[];
  configured?: boolean;
  iconUrl?: string;
}

export interface LinkCredentialField {
  key: string;
  label: string;
  inputType: "text" | "password" | "textarea" | "json";
  required: boolean;
  secret: boolean;
  placeholder?: string;
  description?: string;
  location?: "extra" | "secretExtra";
  defaultValue?: string;
}

export type LinkAuthDefinition = Record<string, unknown> & (
  | { type: "no_auth" }
  | { type: "api_key"; extraFields?: LinkCredentialField[] }
  | { type: "custom_credential"; fields: LinkCredentialField[] }
  | { type: "oauth2"; clientConfigFields?: LinkCredentialField[] }
);

export interface LinkProviderDetail extends LinkProviderSummary {
  auth: LinkAuthDefinition[];
  actions?: LinkActionSummary[];
}

export interface LinkConnectionSummary {
  id?: string;
  service: string;
  configured: boolean;
  default?: boolean;
  connectionName: string;
  authType: string;
  profile?: { accountId?: string; displayName?: string; grantedScopes?: string[] };
}

export interface LinkActionSummary {
  id: string;
  service: string;
  name: string;
  description?: string;
}

export interface LinkActionDetail extends LinkActionSummary {
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  requiredScopes?: string[];
  providerPermissions?: string[];
  readOnly?: boolean;
  markdown?: string;
}

export interface LinkRunSummary {
  id: string;
  service: string;
  actionId: string;
  caller?: "http" | "mcp" | "web";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  ok: boolean;
}

export interface LinkRunDetail extends LinkRunSummary {
  connectionId?: string;
  connectionProfile?: { accountId?: string; displayName?: string; grantedScopes?: string[] };
  inputSummary?: unknown;
  outputSummary?: unknown;
  errorCode?: string;
  errorMessage?: string;
}

export interface LinkRunPage { items: LinkRunSummary[]; nextCursor?: string }

export type LinkOAuthStatus = "pending" | "authorized" | "error" | "cancelled" | "timed_out";

export interface LinkOAuthSession {
  state: string;
  service: string;
  connectionName: string;
  authorizationUrl?: string;
  status: LinkOAuthStatus;
  error?: string;
}

export interface LinkOAuthConfigSummary {
  service: string;
  configured: boolean;
  clientId: string | null;
  expectedRedirectUri: string;
  auth: Record<string, unknown> & { type: "oauth2" };
}

export interface LinkAuthorizationSignal {
  kind: "link_authorization_required";
  service: string;
  actionId: string;
  connectionName?: string;
  threadId: string;
  errorCode: string;
}
