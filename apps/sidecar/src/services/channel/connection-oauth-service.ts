import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthPrompt, ModelAuth, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Channel, ConnectionOAuthSessionStatus } from "@lume/shared";
import {
  deleteConnectionApiKey,
  getConnectionOAuthCredential,
  setConnectionOAuthCredential,
} from "./connection-credential-store";
import { getChannelById, updateChannel } from "./channel-manager";

const OAUTH_PROVIDER_BY_CHANNEL: Partial<Record<Channel["provider"], string>> = {
  anthropic: "anthropic",
  "openai-codex": "openai-codex",
  "github-copilot": "github-copilot",
  openrouter: "openrouter",
  "kimi-coding": "kimi-coding",
  xai: "xai",
};
const BUILTIN_PROVIDERS = builtinProviders();

interface PendingPrompt {
  id: string;
  prompt: AuthPrompt;
  resolve(value: string): void;
  reject(error: Error): void;
}

interface OAuthSession {
  id: string;
  connectionId: string;
  providerId: string;
  status: ConnectionOAuthSessionStatus["status"];
  events: AuthEvent[];
  prompt?: PendingPrompt;
  error?: string;
  controller: AbortController;
  connectionUpdatedAt: number;
  updatedAt: number;
}

const sessions = new Map<string, OAuthSession>();
const SESSION_RETENTION_MS = 10 * 60_000;

function pruneOAuthSessions(now = Date.now()): void {
  for (const [id, session] of sessions) {
    const active = session.status === "running" || session.status === "waiting_for_user";
    if (!active && now - session.updatedAt > SESSION_RETENTION_MS) sessions.delete(id);
  }
}

function resolveProvider(providerId: string): Provider & { auth: { oauth: NonNullable<Provider["auth"]["oauth"]> } } {
  const provider = BUILTIN_PROVIDERS.find((item) => item.id === providerId);
  if (!provider?.auth.oauth) throw new Error(`connection_oauth_provider_unsupported:${providerId}`);
  return provider as Provider & { auth: { oauth: NonNullable<Provider["auth"]["oauth"]> } };
}

export function getConnectionOAuthProviderId(channel: Pick<Channel, "provider">): string | undefined {
  return OAUTH_PROVIDER_BY_CHANNEL[channel.provider];
}

function publicStatus(session: OAuthSession): ConnectionOAuthSessionStatus {
  return {
    sessionId: session.id,
    connectionId: session.connectionId,
    providerId: session.providerId,
    status: session.status,
    events: session.events,
    ...(session.prompt ? {
      prompt: {
        id: session.prompt.id,
        type: session.prompt.prompt.type,
        message: session.prompt.prompt.message,
        ...("placeholder" in session.prompt.prompt && session.prompt.prompt.placeholder
          ? { placeholder: session.prompt.prompt.placeholder }
          : {}),
        ...(session.prompt.prompt.type === "select" ? { options: session.prompt.prompt.options } : {}),
      },
    } : {}),
    ...(session.error ? { error: session.error } : {}),
    updatedAt: session.updatedAt,
  };
}

function prompt(session: OAuthSession, value: AuthPrompt): Promise<string> {
  if (session.controller.signal.aborted) return Promise.reject(new Error("connection_oauth_cancelled"));
  return new Promise((resolve, reject) => {
    const pending: PendingPrompt = {
      id: randomUUID(),
      prompt: value,
      resolve,
      reject,
    };
    session.prompt = pending;
    session.status = "waiting_for_user";
    session.updatedAt = Date.now();
    value.signal?.addEventListener("abort", () => {
      if (session.prompt?.id !== pending.id) return;
      session.prompt = undefined;
      session.status = "running";
      session.updatedAt = Date.now();
      reject(new Error("connection_oauth_prompt_cancelled"));
    }, { once: true });
  });
}

export function startConnectionOAuthLogin(connectionId: string): ConnectionOAuthSessionStatus {
  pruneOAuthSessions();
  const channel = getChannelById(connectionId);
  if (!channel) throw new Error(`渠道不存在: ${connectionId}`);
  const providerId = getConnectionOAuthProviderId(channel);
  if (!providerId) throw new Error(`connection_oauth_provider_unsupported:${channel.provider}`);
  const provider = resolveProvider(providerId);
  for (const session of sessions.values()) {
    if (session.connectionId === connectionId && (session.status === "running" || session.status === "waiting_for_user")) {
      return publicStatus(session);
    }
  }

  const session: OAuthSession = {
    id: randomUUID(),
    connectionId,
    providerId,
    status: "running",
    events: [],
    controller: new AbortController(),
    connectionUpdatedAt: channel.updatedAt,
    updatedAt: Date.now(),
  };
  sessions.set(session.id, session);

  void provider.auth.oauth.login({
    signal: session.controller.signal,
    prompt: (value) => prompt(session, value),
    notify: (event) => {
      session.events.push(event);
      session.updatedAt = Date.now();
    },
  }).then((credential) => {
    const current = getChannelById(connectionId);
    if (!current
      || current.updatedAt !== session.connectionUpdatedAt
      || getConnectionOAuthProviderId(current) !== providerId) {
      throw new Error("connection_oauth_connection_changed");
    }
    setConnectionOAuthCredential(connectionId, credential);
    deleteConnectionApiKey(connectionId);
    const accountLabel = resolveCredentialAccountLabel(credential);
    updateChannel(connectionId, { authType: "oauth", accountLabel: accountLabel ?? "" });
    session.prompt = undefined;
    session.status = "completed";
    session.updatedAt = Date.now();
  }).catch((error) => {
    session.prompt = undefined;
    session.status = session.controller.signal.aborted ? "cancelled" : "failed";
    session.error = error instanceof Error ? error.message : String(error);
    session.updatedAt = Date.now();
  });

  return publicStatus(session);
}

function resolveCredentialAccountLabel(credential: OAuthCredential): string | undefined {
  const value = credential as OAuthCredential & Record<string, unknown>;
  for (const key of ["email", "accountLabel", "login", "username"] as const) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return undefined;
}

export function getConnectionOAuthSession(sessionId: string): ConnectionOAuthSessionStatus {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("connection_oauth_session_not_found");
  return publicStatus(session);
}

export function answerConnectionOAuthPrompt(sessionId: string, promptId: string, value: string): ConnectionOAuthSessionStatus {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("connection_oauth_session_not_found");
  if (!session.prompt || session.prompt.id !== promptId) throw new Error("connection_oauth_prompt_stale");
  const pending = session.prompt;
  session.prompt = undefined;
  session.status = "running";
  session.updatedAt = Date.now();
  pending.resolve(value);
  return publicStatus(session);
}

export function cancelConnectionOAuthLogin(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.controller.abort();
  session.prompt?.reject(new Error("connection_oauth_cancelled"));
  session.prompt = undefined;
  session.status = "cancelled";
  session.updatedAt = Date.now();
}

export async function resolveConnectionOAuthAuth(
  connectionId: string,
  signal?: AbortSignal,
): Promise<{ providerId: string; auth: ModelAuth } | undefined> {
  const channel = getChannelById(connectionId);
  if (!channel || channel.authType !== "oauth") return undefined;
  const providerId = getConnectionOAuthProviderId(channel);
  if (!providerId) return undefined;
  const provider = resolveProvider(providerId);
  let credential = getConnectionOAuthCredential(connectionId);
  if (!credential) return undefined;
  if (credential.expires <= Date.now() + 60_000) {
    const connectionUpdatedAt = channel.updatedAt;
    credential = await provider.auth.oauth.refresh(credential, signal);
    const current = getChannelById(connectionId);
    if (!current
      || current.authType !== "oauth"
      || current.updatedAt !== connectionUpdatedAt
      || getConnectionOAuthProviderId(current) !== providerId) {
      throw new Error("connection_oauth_connection_changed");
    }
    setConnectionOAuthCredential(connectionId, credential);
  }
  return { providerId, auth: await provider.auth.oauth.toAuth(credential as OAuthCredential) };
}

export async function getConnectionOAuthModels(connectionId: string) {
  const channel = getChannelById(connectionId);
  if (!channel) throw new Error(`渠道不存在: ${connectionId}`);
  const providerId = getConnectionOAuthProviderId(channel);
  if (!providerId) throw new Error(`connection_oauth_provider_unsupported:${channel.provider}`);
  const auth = await resolveConnectionOAuthAuth(connectionId);
  if (!auth) throw new Error("connection_oauth_credential_unavailable");
  const provider = resolveProvider(providerId);
  const credential = getConnectionOAuthCredential(connectionId);
  if (!credential) throw new Error("connection_oauth_credential_unavailable");
  const models = provider.getModels();
  return provider.filterModels ? provider.filterModels(models, credential) : models;
}
