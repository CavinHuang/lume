import type { LinkConnectionSummary, LinkOAuthSession } from "@lume/shared";
import { linkAdminRequest } from "../services/link/link-client";
import type { NotificationWriter, RpcHandler } from "./types";

const pendingOAuth = new Map<string, LinkOAuthSession & { startedAt: number }>();

export function createLinkHandlers(writeNotification: NotificationWriter): Record<string, RpcHandler> {
  const notifyConnections = (value: unknown) => writeNotification("link:connections-changed", value);
  return {
    "link:providers-list": async (params) => {
      const providers = await linkAdminRequest<unknown[]>("/api/providers");
      const input = asRecord(params);
      const query = stringValue(input.query).toLowerCase();
      const category = stringValue(input.category).toLowerCase();
      return providers.filter((provider) => {
        const item = asRecord(provider);
        const text = `${stringValue(item.service)} ${stringValue(item.displayName)} ${stringValue(item.description)}`.toLowerCase();
        const categories = Array.isArray(item.categories) ? item.categories.map(String).map((value) => value.toLowerCase()) : [];
        return (!query || text.includes(query)) && (!category || categories.includes(category));
      }).map(toProviderSummary);
    },
    "link:providers-search": async (params) => {
      const query = requiredString(params, "query").toLowerCase();
      const providers = await linkAdminRequest<unknown[]>("/api/providers");
      return providers.filter((provider) => {
        const item = asRecord(provider);
        return `${stringValue(item.service)} ${stringValue(item.displayName)} ${stringValue(item.description)}`.toLowerCase().includes(query);
      }).map(toProviderSummary);
    },
    "link:provider-detail": async (params) => linkAdminRequest(`/api/providers/${encodeURIComponent(requiredString(params, "service"))}`),
    "link:connections-list": async () => {
      const connections = await linkAdminRequest<unknown[]>("/api/connections");
      return connections.map(toConnectionSummary);
    },
    "link:connection-upsert": async (params) => {
      const input = asRecord(params);
      const service = requiredString(input, "service");
      await linkAdminRequest(`/api/connections/${encodeURIComponent(service)}`, {
        method: "PUT",
        body: JSON.stringify({
          connectionName: requiredString(input, "connectionName"),
          authType: requiredString(input, "authType"),
          values: asRecord(input.credentials),
        }),
      });
      const connectionName = requiredString(input, "connectionName");
      notifyConnections({ service, connectionName });
      return { service, connectionName, configured: true };
    },
    "link:connection-delete": async (params) => {
      const input = asRecord(params);
      const service = requiredString(input, "service");
      const connectionName = requiredString(input, "connectionName");
      await linkAdminRequest(`/api/connections/${encodeURIComponent(service)}`, {
        method: "DELETE",
        body: JSON.stringify({ connectionName }),
      });
      notifyConnections({ service, connectionName });
      return { service, connectionName, configured: false };
    },
    "link:oauth-configs": async () => {
      const configs = await linkAdminRequest<unknown[]>("/api/oauth/configs");
      return configs.map(toOAuthConfigSummary);
    },
    "link:oauth-sessions": async () => {
      expireOAuthSessions();
      return [...pendingOAuth.values()].map(withoutStartedAt);
    },
    "link:oauth-config-save": async (params) => {
      const input = asRecord(params);
      const service = requiredString(input, "service");
      await linkAdminRequest(`/api/oauth/configs/${encodeURIComponent(service)}`, {
        method: "PUT",
        body: JSON.stringify({ clientId: requiredString(input, "clientId"), clientSecret: stringValue(input.clientSecret), extra: asRecord(input.extra), secretExtra: asRecord(input.secretExtra) }),
      });
      writeNotification("link:authorization-changed", { service, configured: true });
      return { service, configured: true };
    },
    "link:oauth-start": async (params) => {
      const input = asRecord(params);
      const service = requiredString(input, "service");
      const connectionName = requiredString(input, "connectionName");
      const result = asRecord(await linkAdminRequest("/api/oauth/authorizations", {
        method: "POST",
        body: JSON.stringify({ service, connectionName }),
      }));
      const state = requiredString(result, "state");
      const session: LinkOAuthSession & { startedAt: number } = {
        state,
        service,
        connectionName,
        authorizationUrl: requiredString(result, "authorizationUrl"),
        status: "pending",
        startedAt: Date.now(),
      };
      pendingOAuth.set(state, session);
      return withoutStartedAt(session);
    },
    "link:oauth-status": async (params) => {
      const state = requiredString(params, "state");
      const session = pendingOAuth.get(state);
      if (!session) throw new Error("link_oauth_session_not_found");
      if (session.status !== "pending") return withoutStartedAt(session);
      if (Date.now() - session.startedAt > 5 * 60_000) session.status = "timed_out";
      if (session.status === "pending") {
        const connections = await linkAdminRequest<LinkConnectionSummary[]>("/api/connections");
        if (connections.some((item) => item.service === session.service && item.connectionName === session.connectionName && item.configured)) {
          session.status = "authorized";
          notifyConnections({ service: session.service, connectionName: session.connectionName });
        }
      }
      return withoutStartedAt(session);
    },
    "link:oauth-cancel": async (params) => {
      const session = pendingOAuth.get(requiredString(params, "state"));
      if (session?.status === "pending") session.status = "cancelled";
      return session ? withoutStartedAt(session) : { status: "cancelled" };
    },
    "link:actions-list": async (params) => {
      const input = asRecord(params);
      const query = new URLSearchParams();
      if (stringValue(input.service)) query.set("service", stringValue(input.service));
      if (stringValue(input.query)) {
        query.set("q", stringValue(input.query));
        return linkAdminRequest(`/api/actions/search?${query}`);
      }
      const actions = await linkAdminRequest<unknown[]>("/api/actions");
      return stringValue(input.service) ? actions.filter((item) => asRecord(item).service === stringValue(input.service)) : actions;
    },
    "link:action-detail": async (params) => linkAdminRequest(`/api/actions/${encodeURIComponent(requiredString(params, "action"))}`),
    "link:runs-list": async (params) => {
      const input = asRecord(params);
      const query = new URLSearchParams();
      const limit = Number(input.limit);
      if (Number.isInteger(limit) && limit >= 1 && limit <= 100) query.set("limit", String(limit));
      for (const key of ["cursor", "service", "actionId", "caller"] as const) {
        if (stringValue(input[key])) query.set(key, stringValue(input[key]));
      }
      if (typeof input.ok === "boolean") query.set("ok", String(input.ok));
      const suffix = query.size ? `?${query}` : "";
      const page = asRecord(await linkAdminRequest(`/api/runs${suffix}`));
      return {
        items: Array.isArray(page.items) ? page.items.map(toRunSummary) : [],
        ...(stringValue(page.nextCursor) ? { nextCursor: stringValue(page.nextCursor) } : {}),
      };
    },
    "link:run-detail": async (params) => toRunDetail(await linkAdminRequest(`/api/runs/${encodeURIComponent(requiredString(params, "runId"))}`)),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function stringValue(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function toProviderSummary(value: unknown): Record<string, unknown> {
  const input = asRecord(value);
  return {
    service: stringValue(input.service),
    displayName: stringValue(input.displayName) || stringValue(input.service),
    ...(stringValue(input.description) ? { description: stringValue(input.description) } : {}),
    categories: Array.isArray(input.categories) ? input.categories.map(String) : [],
    authTypes: Array.isArray(input.authTypes) ? input.authTypes.map(String) : [],
  };
}
function toRunSummary(value: unknown): Record<string, unknown> {
  const input = asRecord(value);
  return {
    id: stringValue(input.id),
    service: stringValue(input.service),
    actionId: stringValue(input.actionId),
    ...(stringValue(input.caller) ? { caller: stringValue(input.caller) } : {}),
    startedAt: stringValue(input.startedAt),
    completedAt: stringValue(input.completedAt),
    durationMs: typeof input.durationMs === "number" ? input.durationMs : 0,
    ok: input.ok === true,
  };
}
function toRunDetail(value: unknown): Record<string, unknown> {
  const input = asRecord(value);
  return {
    ...toRunSummary(input),
    ...(stringValue(input.connectionId) ? { connectionId: stringValue(input.connectionId) } : {}),
    ...(toConnectionProfile(input.connectionProfile) ? { connectionProfile: toConnectionProfile(input.connectionProfile) } : {}),
    ...(Object.hasOwn(input, "inputSummary") ? { inputSummary: input.inputSummary } : {}),
    ...(Object.hasOwn(input, "outputSummary") ? { outputSummary: input.outputSummary } : {}),
    ...(stringValue(input.errorCode) ? { errorCode: stringValue(input.errorCode) } : {}),
    ...(stringValue(input.errorMessage) ? { errorMessage: stringValue(input.errorMessage) } : {}),
  };
}
function toConnectionSummary(value: unknown): Record<string, unknown> {
  const input = asRecord(value);
  return {
    ...(stringValue(input.id) ? { id: stringValue(input.id) } : {}),
    service: stringValue(input.service),
    configured: input.configured === true,
    default: input.default === true,
    connectionName: stringValue(input.connectionName) || "default",
    authType: stringValue(input.authType),
    ...(toConnectionProfile(input.profile) ? { profile: toConnectionProfile(input.profile) } : {}),
  };
}
function toConnectionProfile(value: unknown): Record<string, unknown> | undefined {
  const input = asRecord(value);
  const accountId = stringValue(input.accountId);
  const displayName = stringValue(input.displayName);
  const grantedScopes = Array.isArray(input.grantedScopes) ? input.grantedScopes.map(String) : [];
  return accountId || displayName || grantedScopes.length ? { accountId, displayName, grantedScopes } : undefined;
}
function toOAuthConfigSummary(value: unknown): Record<string, unknown> {
  const input = asRecord(value);
  return {
    service: stringValue(input.service),
    configured: input.configured === true,
    clientId: typeof input.clientId === "string" ? input.clientId : null,
    expectedRedirectUri: stringValue(input.expectedRedirectUri),
    auth: asRecord(input.auth),
  };
}
function requiredString(value: unknown, key: string): string {
  const result = stringValue(asRecord(value)[key]);
  if (!result) throw new Error(`invalid_link_${key}`);
  return result;
}
function withoutStartedAt(session: LinkOAuthSession & { startedAt: number }): LinkOAuthSession {
  const { startedAt: _startedAt, ...result } = session;
  return result;
}
function expireOAuthSessions(): void {
  const now = Date.now();
  for (const session of pendingOAuth.values()) {
    if (session.status === "pending" && now - session.startedAt > 5 * 60_000) session.status = "timed_out";
  }
}
