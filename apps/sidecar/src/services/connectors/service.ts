import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type {
  CredentialValidators,
  OAuth2AuthDefinition,
  ProviderDefinition,
  ProviderExecutors,
  ResolvedCredential,
} from "./core/types";
import { executeAction } from "./core/execution";
import { requestAuthorizationCodeToken, requestRefreshToken } from "./oauth/oauth-token";
import { providerFetch } from "./providers/provider-runtime";
import { credentialValidators as gmailValidators, executors as gmailExecutors } from "./providers/gmail/executors";
import { provider as gmailProviderDefinition } from "./providers/gmail/definition";
import {
  deleteConnectorCredential,
  getConnectorClientConfig,
  getConnectorOAuthCredential,
  setConnectorOAuthCredential,
} from "./credential-store";

/** 一个已注册连接器 = 目录契约 + 执行器 + 凭证验证器。 */
export interface ConnectorProvider {
  definition: ProviderDefinition;
  executors: ProviderExecutors;
  validators?: CredentialValidators;
}

const providers = new Map<string, ConnectorProvider>();

export function registerConnector(provider: ConnectorProvider): void {
  providers.set(provider.definition.service, provider);
}

export function getConnector(service: string): ConnectorProvider {
  const provider = providers.get(service);
  if (!provider) throw new ConnectorError("connector_unknown", `连接器未注册: ${service}`);
  return provider;
}

export function listConnectors(): string[] {
  return [...providers.keys()];
}

export class ConnectorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

// ---------------------------------------------------------------------------
// OAuth 授权流:临时 loopback 监听 + 两段式 state
// ---------------------------------------------------------------------------

interface PendingAuthorization {
  service: string;
  state: string;
  server: Server;
  resolve: (credential: ResolvedCredential & { authType: "oauth2" }) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const pendingAuthorizations = new Map<string, PendingAuthorization>();
const OAUTH_CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;

function requireOAuthAuth(service: string): OAuth2AuthDefinition {
  const auth = getConnector(service).definition.auth.find((entry) => entry.type === "oauth2");
  if (!auth) throw new ConnectorError("connector_auth_unsupported", `${service} 不支持 OAuth2 授权`);
  return auth;
}

export interface ConnectorAuthorizationFlow {
  /** 授权页 URL(loopback 监听就绪后 resolve),交给系统浏览器打开。 */
  authorizationUrl: Promise<string>;
  /** 授权完成:成功 resolve 凭证,取消/失败/超时 reject。 */
  done: Promise<ResolvedCredential & { authType: "oauth2" }>;
}

/**
 * 发起授权:起临时 loopback 监听并构建授权 URL。
 * Google 对 desktop 类 OAuth client 允许 127.0.0.1 任意端口回调,无需在控制台登记。
 */
export function startConnectorAuthorization(service: string): ConnectorAuthorizationFlow {
  const existing = pendingAuthorizations.get(service);
  if (existing) stopPendingAuthorization(service, new ConnectorError("oauth_flow_superseded", "已发起新的授权"));

  const config = getConnectorClientConfig(service);
  if (!config?.clientId || !config.clientSecret) {
    throw new ConnectorError("oauth_client_config_required", `请先配置 ${service} 的 OAuth client_id 与 client_secret`);
  }
  const auth = requireOAuthAuth(service);

  let resolveUrl!: (url: string) => void;
  const authorizationUrl = new Promise<string>((resolve) => (resolveUrl = resolve));
  const done = new Promise<ResolvedCredential & { authType: "oauth2" }>((resolve, reject) => {
    const server = createServer((req, res) => void handleOAuthCallback(req, res, service));

    const finish = (fn: () => void) => {
      clearTimeout(timer);
      server.close();
      pendingAuthorizations.delete(service);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new ConnectorError("oauth_flow_timeout", "授权超时,请重试")));
    }, OAUTH_CALLBACK_TIMEOUT_MS);

    server.on("error", (error) => {
      finish(() => reject(new ConnectorError("oauth_listen_failed", `本地回调监听失败: ${String(error)}`)));
    });
    // 随机端口绑定后才能拼 redirect_uri,再构建授权 URL
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const state = crypto.randomUUID();
      pendingAuthorizations.set(service, {
        service,
        state,
        server,
        resolve: (credential) => finish(() => resolve(credential)),
        reject: (error) => finish(() => reject(error)),
        timer,
      });
      resolveUrl(buildAuthorizationUrl(service, auth, config.clientId, redirectUri, state));
    });
  });

  return { authorizationUrl, done };
}

async function handleOAuthCallback(req: IncomingMessage, res: ServerResponse, service: string): Promise<void> {
  const pending = pendingAuthorizations.get(service);
  if (!pending) {
    res.writeHead(404).end();
    return;
  }
  const url = new URL(req.url ?? "/", `http://127.0.0.1`);
  const respondPage = (ok: boolean, message: string) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
      `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;display:grid;place-items:center;height:90vh"><p>${
        ok ? "✅" : "❌"
      } ${message}</p></body>`,
    );
  };

  try {
    if (url.searchParams.get("state") !== pending.state) {
      throw new ConnectorError("invalid_oauth_state", "OAuth state 不匹配或已过期");
    }
    const code = url.searchParams.get("code");
    if (!code) {
      const reason = url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? "未返回授权码";
      throw new ConnectorError("oauth_denied", `授权被取消: ${reason}`);
    }
    const config = getConnectorClientConfig(service);
    const auth = requireOAuthAuth(service);
    if (!config) throw new ConnectorError("oauth_client_config_required", "OAuth client 配置丢失");

    const credential = await requestAuthorizationCodeToken({
      code,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: `http://127.0.0.1:${(pending.server.address() as { port: number }).port}/callback`,
      tokenEndpointAuthMethod: auth.tokenEndpointAuthMethod,
      tokenRequestFormat: auth.tokenRequestFormat,
      responseEnvelope: auth.tokenResponseEnvelope,
      tokenRequestFields: auth.tokenRequestFields,
      tokenUrl: auth.tokenUrl,
      createError: (message) => new ConnectorError("oauth_token_exchange_failed", message),
    });

    await validateAndStoreCredential(service, credential);
    pending.resolve(credential);
    respondPage(true, "授权成功,可以关闭此页面回到 Lume。");
  } catch (error) {
    const connectorError = error instanceof ConnectorError ? error : new ConnectorError("oauth_flow_failed", String(error));
    pending.reject(connectorError);
    respondPage(false, connectorError.message);
  }
}

function buildAuthorizationUrl(
  service: string,
  auth: OAuth2AuthDefinition,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const url = new URL(auth.authorizationUrl);
  for (const [key, value] of Object.entries(auth.authorizationParams ?? {})) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  const scopes = configRequestedScopes(service, auth);
  if (scopes.length > 0) {
    url.searchParams.set("scope", scopes.join(auth.scopeSeparator ?? " "));
  }
  return url.toString();
}

function configRequestedScopes(service: string, auth: OAuth2AuthDefinition): string[] {
  const configured = getConnectorClientConfig(service)?.requestedScopes;
  if (configured && configured.length > 0) {
    const allowed = new Set(auth.scopes);
    return configured.filter((scope: string) => allowed.has(scope));
  }
  return auth.scopes;
}

/** 跑凭证验证器补全 profile(邮箱等),落盘 vault。 */
async function validateAndStoreCredential(service: string, credential: ResolvedCredential & { authType: "oauth2" }): Promise<void> {
  const provider = getConnector(service);
  let stored = credential;
  try {
    const validated = await provider.validators?.oauth2?.(credential, { fetcher: providerFetch });
    if (validated?.profile) {
      stored = {
        ...credential,
        profile: {
          accountId: validated.profile.accountId ?? "oauth2",
          displayName: validated.profile.displayName ?? "OAuth Credential",
          grantedScopes: validated.profile.grantedScopes ?? [],
        },
      };
    }
  } catch {
    // 验证失败不阻断授权:token 本身已兑换成功
  }
  setConnectorOAuthCredential(service, stored);
}

// ---------------------------------------------------------------------------
// 凭证生命周期:读取 + 过期自动刷新 + 断开
// ---------------------------------------------------------------------------

const TOKEN_REFRESH_LEEWAY_MS = 60_000;

export async function getConnectorOAuthCredentialFresh(service: string): Promise<ResolvedCredential & { authType: "oauth2" }> {
  const credential = getConnectorOAuthCredential(service);
  if (!credential) throw new ConnectorError("connector_not_connected", `${service} 尚未连接`);
  if (!isExpiredSoon(credential)) return credential;

  const refreshed = await refreshConnectorCredential(service, credential);
  setConnectorOAuthCredential(service, refreshed);
  return refreshed;
}

function isExpiredSoon(credential: ResolvedCredential & { authType: "oauth2" }): boolean {
  if (!credential.expiresAt) return false;
  const expiresAt = Date.parse(credential.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt - TOKEN_REFRESH_LEEWAY_MS <= Date.now();
}

export async function refreshConnectorCredential(
  service: string,
  stale: ResolvedCredential & { authType: "oauth2" },
): Promise<ResolvedCredential & { authType: "oauth2" }> {
  const config = getConnectorClientConfig(service);
  const auth = requireOAuthAuth(service);
  if (!config || !stale.refreshToken) {
    throw new ConnectorError("oauth_refresh_unavailable", "缺少 refresh token 或 OAuth client 配置,请重新授权");
  }
  const refreshed = await requestRefreshToken({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    refreshToken: stale.refreshToken,
    tokenEndpointAuthMethod: auth.tokenEndpointAuthMethod,
    tokenRequestFormat: auth.tokenRequestFormat,
    responseEnvelope: auth.tokenResponseEnvelope,
    tokenRequestFields: auth.tokenRequestFields,
    tokenUrl: auth.refreshTokenUrl ?? auth.tokenUrl,
    createError: (message) => new ConnectorError("oauth_token_refresh_failed", message),
  });
  return {
    ...refreshed,
    refreshToken: refreshed.refreshToken ?? stale.refreshToken,
    expiresAt: refreshed.expiresAt ?? stale.expiresAt,
    profile: stale.profile,
    metadata: { ...stale.metadata, ...refreshed.metadata, refreshedAt: new Date().toISOString() },
  };
}

export function disconnectConnector(service: string): void {
  const pending = pendingAuthorizations.get(service);
  if (pending) stopPendingAuthorization(service, new ConnectorError("oauth_flow_cancelled", "授权已取消"));
  deleteConnectorCredential(service);
}

function stopPendingAuthorization(service: string, error: Error): void {
  const pending = pendingAuthorizations.get(service);
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.server.close();
  pendingAuthorizations.delete(service);
  pending.reject(error);
}

// ---------------------------------------------------------------------------
// Action 执行
// ---------------------------------------------------------------------------

export async function executeConnectorAction(
  service: string,
  actionName: string,
  input: unknown,
): Promise<{ ok: boolean; output?: unknown; error?: { code: string; message: string; details?: unknown } }> {
  const provider = getConnector(service);
  const action = provider.definition.actions.find((entry) => entry.name === actionName);
  if (!action) {
    return { ok: false, error: { code: "action_unknown", message: `${service} 不支持动作: ${actionName}` } };
  }
  const context = {
    getCredential: async () => {
      try {
        return await getConnectorOAuthCredentialFresh(service);
      } catch (error) {
        if (error instanceof ConnectorError && error.code === "connector_not_connected") return undefined;
        throw error;
      }
    },
    signal: undefined,
  };
  return executeAction(
    action,
    provider.executors[action.id as keyof typeof provider.executors],
    input,
    context,
  );
}

// ---------------------------------------------------------------------------
// 内置连接器注册
// ---------------------------------------------------------------------------

registerConnector({
  definition: gmailProviderDefinition,
  executors: gmailExecutors,
  validators: gmailValidators,
});
