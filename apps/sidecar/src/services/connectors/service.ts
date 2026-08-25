import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type {
  CredentialValidators,
  OAuth2AuthDefinition,
  ProviderDefinition,
  ProviderExecutors,
  ResolvedCredential,
} from "./core/types";
import type { ConnectorSetup } from "@lume/shared";
import { executeAction } from "./core/execution";
import { requestAuthorizationCodeToken, requestRefreshToken } from "./oauth/oauth-token";
import { providerFetch } from "./providers/provider-runtime";
import { credentialValidators as gmailValidators, executors as gmailExecutors } from "./providers/gmail/executors";
import { provider as gmailProviderDefinition } from "./providers/gmail/definition";
import { credentialValidators as qqMailValidators, executors as qqMailExecutors } from "./providers/qq_mail/executors";
import { provider as qqMailProviderDefinition } from "./providers/qq_mail/definition";
import {
  clearConnectorCredentialData,
  deleteConnectorCredential,
  getConnectorClientConfig,
  getConnectorCustomValues,
  getConnectorOAuthCredential,
  setConnectorCustomValues,
  setConnectorOAuthCredential,
} from "./credential-store";
import { createLogger } from "../infra/logger";

const logger = createLogger("connectors");
/** RuntimeLogger 形状适配:仓内 Logger 为 (msg, data),core/types 的 RuntimeLogger 为 (fields, msg)。 */
const runtimeLogger = {
  error: (fields: Record<string, unknown>, message: string) => logger.error(message, fields),
  info: (fields: Record<string, unknown>, message: string) => logger.info(message, fields),
  warn: (fields: Record<string, unknown>, message: string) => logger.warn(message, fields),
};

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

/** 从 definition 提取配置向导:表单字段与注册指引,web 按此渲染。 */
export function getConnectorSetup(service: string): ConnectorSetup {
  const provider = getConnector(service);
  const { definition } = provider;
  const oauth2 = definition.auth.find((auth): auth is OAuth2AuthDefinition => auth.type === "oauth2");
  if (oauth2) {
    return {
      service,
      displayName: definition.displayName,
      authKind: "oauth2",
      fields: [],
      clientSetup: oauth2.clientSetup
        ? { docsUrl: oauth2.clientSetup.docsUrl, steps: [...oauth2.clientSetup.steps] }
        : undefined,
    };
  }
  const custom = definition.auth.find((auth) => auth.type === "custom_credential");
  const fields =
    custom?.type === "custom_credential"
      ? custom.fields.map((field) => ({
        key: field.key,
        label: field.label,
        inputType: field.inputType === "password" ? ("password" as const) : ("text" as const),
        placeholder: field.placeholder,
        description: field.description,
      }))
      : [];
  return { service, displayName: definition.displayName, authKind: "custom", fields };
}

import { ConnectorError } from "./core/errors";

export { ConnectorError };

// ---------------------------------------------------------------------------
// OAuth 授权流:临时 loopback 监听 + 两段式 state
// ---------------------------------------------------------------------------

interface PendingAuthorization {
  service: string;
  state: string;
  /** PKCE S256 verifier:授权 URL 带 challenge,token 兑换带 verifier。 */
  codeVerifier: string;
  server: Server;
  resolve: (credential: ResolvedCredential & { authType: "oauth2" }) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  /** 授权 URL 尚未产出时终结流程,须一并 settle url promise,否则 START_AUTH 悬挂至 RPC 超时。 */
  settleUrlIfPending: (error: Error) => void;
  /** state 命中后置位:同 code 的重复回调不再触碰流程 promise(Google 授权码一次性)。 */
  consumed?: boolean;
}

const pendingAuthorizations = new Map<string, PendingAuthorization>();
const OAUTH_CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;

// 测试 seam:授权流需要复现"listen 尚未回调即失败"的窗口,真实 bind 无法稳定注入。
let httpServerFactory: typeof createServer = createServer;
/** @internal 仅测试使用;调用方负责还原默认工厂。 */
export function setHttpServerFactoryForTest(factory: typeof createServer): void {
  httpServerFactory = factory;
}

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
  // 配置校验先于作废旧流:否则配置缺失时旧授权被无谓打断,新流又建不起来
  const config = getConnectorClientConfig(service);
  if (!config?.clientId || !config.clientSecret) {
    throw new ConnectorError("oauth_client_config_required", `请先配置 ${service} 的 OAuth client_id 与 client_secret`);
  }
  const existing = pendingAuthorizations.get(service);
  if (existing) stopPendingAuthorization(service, new ConnectorError("oauth_flow_superseded", "已发起新的授权"));
  const auth = requireOAuthAuth(service);

  let resolveUrl!: (url: string) => void;
  let rejectUrl!: (error: Error) => void;
  let urlSettled = false;
  const settleUrlIfPending = (error: Error) => {
    if (!urlSettled) {
      urlSettled = true;
      rejectUrl(error);
    }
  };
  const authorizationUrl = new Promise<string>((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });
  const done = new Promise<ResolvedCredential & { authType: "oauth2" }>((resolve, reject) => {
    const server = httpServerFactory((req, res) => void handleOAuthCallback(req, res, service));

    const finish = (fn: () => void) => {
      clearTimeout(timer);
      server.close();
      pendingAuthorizations.delete(service);
      // listen 前失败(绑定被拒/supersede)时 url 永不产出,必须同步 settle,
      // 否则 handler 的 await authorizationUrl 挂死而真实错误丢失
      settleUrlIfPending(new ConnectorError("oauth_flow_cancelled", "授权流已终止"));
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
      // PKCE S256(RFC 7636):同机进程即便截获 state/授权码,没有 verifier 也换不到 token
      const codeVerifier = randomBytes(48).toString("base64url");
      const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
      pendingAuthorizations.set(service, {
        service,
        state,
        codeVerifier,
        server,
        resolve: (credential) => finish(() => resolve(credential)),
        reject: (error) => finish(() => reject(error)),
        timer,
        settleUrlIfPending,
      });
      resolveUrl(
        buildAuthorizationUrl(service, auth, config.clientId, redirectUri, state, codeChallenge),
      );
      logger.info("connector oauth flow started", { service, port });
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
    // error_description 等来自回调查询串,反射进 HTML 前必须转义
    const text = `${ok ? "✅" : "❌"} ${message
      .split("&")
      .join("&amp;")
      .split("<")
      .join("&lt;")
      .split(">")
      .join("&gt;")
      .split('"')
      .join("&quot;")}`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
      `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;display:grid;place-items:center;height:90vh"><p>${text}</p></body>`,
    );
  };

  try {
    if (url.searchParams.get("state") !== pending.state) {
      // 杂散请求(浏览器预取/刷新、端口扫描)只对该请求回错误页;
      // reject 整个 pending 流程会让随后到达的真回调扑空
      logger.debug("connector oauth callback state mismatch (stray request)", { service });
      respondPage(false, "OAuth state 不匹配或已过期。若非误开此页,请回到 Lume 重新发起授权。");
      return;
    }
    if (pending.consumed) {
      // 同一 code 的第二次回调(成功页加载慢时刷新最常见):Google 授权码一次性,
      // 二次兑换必 invalid_grant,不能让后到者把已成功的流 reject 掉
      respondPage(true, "授权正在处理或已完成,请回到 Lume 查看。");
      return;
    }
    pending.consumed = true;
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
      extraFields: { code_verifier: pending.codeVerifier },
      tokenEndpointAuthMethod: auth.tokenEndpointAuthMethod,
      tokenRequestFormat: auth.tokenRequestFormat,
      responseEnvelope: auth.tokenResponseEnvelope,
      tokenRequestFields: auth.tokenRequestFields,
      tokenUrl: auth.tokenUrl,
      createError: (message) => new ConnectorError("oauth_token_exchange_failed", message),
    });

    // 兑换期间流可能已被顶掉/断开(pending 从 map 摘除):盲写会把凭证复活进已终止的流程
    if (pendingAuthorizations.get(service) !== pending) {
      respondPage(false, "授权已失效(流程已终止),请回到 Lume 重新发起。");
      return;
    }
    const stored = await validateAndStoreCredential(service, credential, pending);
    if (!stored) {
      // validator 是兑换后的又一个异步边界,断开会摘除 map 条目但无法取消本函数:
      // 落盘前复检失配即弃。与上方守卫同构——done 已被断开 reject,不再触碰流程 promise
      logger.warn("connector oauth flow cancelled during validation; skip persist", { service });
      respondPage(false, "授权已失效(流程已终止),请回到 Lume 重新发起。");
      return;
    }
    logger.info("connector oauth flow completed", { service });
    pending.resolve(credential);
    respondPage(true, "授权成功,可以关闭此页面回到 Lume。");
  } catch (error) {
    const connectorError = error instanceof ConnectorError ? error : new ConnectorError("oauth_flow_failed", String(error));
    logger.warn("connector oauth callback rejected", {
      service,
      code: connectorError.code,
    });
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
  codeChallenge: string,
): string {
  const url = new URL(auth.authorizationUrl);
  for (const [key, value] of Object.entries(auth.authorizationParams ?? {})) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
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
    const filtered = configured.filter((scope: string) => allowed.has(scope));
    if (filtered.length > 0) return filtered;
    // 配置与允许集零交集时回退默认全量:否则发出无 scope 的授权 URL,
    // 拿到的 token 缺业务权限,要到调用阶段才报错
    logger.warn("requestedScopes 与允许集零交集,回退 provider 默认 scopes", { service });
  }
  return auth.scopes;
}

/** 跑凭证验证器补全 profile(邮箱等),落盘 vault。返回 false 表示流已被断开/顶替,未落盘。 */
async function validateAndStoreCredential(
  service: string,
  credential: ResolvedCredential & { authType: "oauth2" },
  pending: PendingAuthorization,
): Promise<boolean> {
  const provider = getConnector(service);
  let stored = credential;
  try {
    const validated = await provider.validators?.oauth2?.(credential, { fetcher: providerFetch, logger: runtimeLogger });
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
  } catch (error) {
    // 验证失败不阻断授权:token 本身已兑换成功;但 profile 会落默认值,留痕供排查
    logger.warn("connector oauth2 validator failed", { service, error: error instanceof Error ? error.message : String(error) });
  }
  // validator await 期间流可能已被断开/顶替:此处是最后一次落盘闸门,复检失配即弃,
  // 否则断开后的盲写会让 connected 复活(#689)。复检到写盘之间纯同步,无插入窗口。
  if (pendingAuthorizations.get(service) !== pending) {
    return false;
  }
  setConnectorOAuthCredential(service, stored);
  return true;
}

// ---------------------------------------------------------------------------
// 凭证生命周期:读取 + 过期自动刷新 + 断开
// ---------------------------------------------------------------------------

const TOKEN_REFRESH_LEEWAY_MS = 60_000;

/**
 * 保存授权码型凭证(QQ 邮箱等):跑 provider 的连接测试后落盘。
 * 验证失败抛 ConnectorError,由调用方决定提示。
 */
export async function saveConnectorCustomCredential(service: string, values: Record<string, string>): Promise<void> {
  // 连接测试是长 await:期间断开/再次保存时,旧请求不得把过期结果写回
  const epoch = (saveEpochs.get(service) ?? 0) + 1;
  saveEpochs.set(service, epoch);
  const provider = getConnector(service);
  const validator = provider.validators?.customCredential;
  let profile: { accountId: string; displayName: string; grantedScopes: string[] } = {
    accountId: "custom",
    displayName: values.email ?? "Custom Credential",
    grantedScopes: [],
  };
  if (validator) {
    const result = await validator({ values }, { fetcher: providerFetch, logger: runtimeLogger });
    if (result?.profile) {
      profile = {
        accountId: result.profile.accountId ?? profile.accountId,
        displayName: result.profile.displayName ?? profile.displayName,
        grantedScopes: result.profile.grantedScopes ?? [],
      };
    }
  }
  if (saveEpochs.get(service) !== epoch) {
    throw new ConnectorError("connector_save_superseded", "已有更新的保存/断开操作,本次结果已忽略");
  }
  setConnectorCustomValues(service, values);
}

/** 授权码型保存的代际号:validator 在途期间发生断开/再保存,旧请求落盘前失配即弃。 */
const saveEpochs = new Map<string, number>();

/** 统一解析当前凭证:OAuth 型带过期刷新,授权码型直读。未连接抛错。 */
export async function getConnectorResolvedCredential(service: string): Promise<ResolvedCredential> {
  const provider = getConnector(service);
  const supportsOauth = provider.definition.authTypes.includes("oauth2");
  if (supportsOauth) return getConnectorOAuthCredentialFresh(service);

  const customValues = getConnectorCustomValues(service);
  if (customValues) {
    return { authType: "custom_credential", values: customValues, profile: readCustomProfile(service), metadata: {} };
  }
  throw new ConnectorError("connector_not_connected", `${service} 尚未连接`);
}

function readCustomProfile(service: string): { accountId: string; displayName: string; grantedScopes: string[] } {
  const values = getConnectorCustomValues(service);
  return { accountId: values?.email ?? "custom", displayName: values?.email ?? "Custom Credential", grantedScopes: [] };
}

export function hasAnyConnectorCredential(service: string): boolean {
  return getConnectorOAuthCredential(service) !== undefined || getConnectorCustomValues(service) !== undefined;
}

/** 进行中的 token 刷新,按 service 单飞:并发命中过期共享同一次刷新,防轮换型 provider 的 refresh token 互踩作废。 */
const inFlightRefreshes = new Map<string, Promise<ResolvedCredential & { authType: "oauth2" }>>();

export async function getConnectorOAuthCredentialFresh(service: string): Promise<ResolvedCredential & { authType: "oauth2" }> {
  const credential = getConnectorOAuthCredential(service);
  if (!credential) throw new ConnectorError("connector_not_connected", `${service} 尚未连接`);
  if (!isExpiredSoon(credential)) return credential;

  let inFlight = inFlightRefreshes.get(service);
  if (!inFlight) {
    logger.debug("connector oauth token refresh started", { service });
    inFlight = refreshConnectorCredential(service, credential)
      .then((refreshed) => {
        // 仅当存储中仍是发起刷新的那条记录时才落盘:期间若用户断开重连,
        // 盲写会把新授权的凭证覆盖回旧的
        const current = getConnectorOAuthCredential(service);
        if (current?.refreshToken === credential.refreshToken && current?.expiresAt === credential.expiresAt) {
          setConnectorOAuthCredential(service, refreshed);
          logger.debug("connector oauth token refreshed", { service });
        } else {
          // 新 token 不落盘:本次调用仍可用,但下次过期会再刷一次——
          // 若频繁出现说明存储被并发改写,需人工介入
          logger.warn("connector oauth token refreshed but store changed; skip persist", { service });
        }
        return refreshed;
      })
      .finally(() => {
        inFlightRefreshes.delete(service);
      });
    inFlightRefreshes.set(service, inFlight);
  }
  return inFlight;
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
  // 使在途的授权码保存失配:连接测试期间断开,旧请求不得把凭证写回。
  // 必须 bump 而非 delete:归零复用会让断开后的新一轮保存与在途旧保存撞号,
  // 守卫双双失效(旧保存落盘复活)
  saveEpochs.set(service, (saveEpochs.get(service) ?? 0) + 1);
  // 断开 ≠ 忘记配置:清凭证但保留用户手填的 OAuth client_id/secret,
  // 否则 Gmail 重连要重新翻 GCP Console 抄一遍
  clearConnectorCredentialData(service);
}

function stopPendingAuthorization(service: string, error: Error): void {
  const pending = pendingAuthorizations.get(service);
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.server.close();
  pendingAuthorizations.delete(service);
  // listen 回调触发前的 supersede/断开:url promise 尚未产出,一并终结防悬挂
  pending.settleUrlIfPending(error);
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
        return await getConnectorResolvedCredential(service);
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

registerConnector({
  definition: qqMailProviderDefinition,
  executors: qqMailExecutors,
  validators: qqMailValidators,
});
