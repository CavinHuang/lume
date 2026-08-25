import type { ExecutionContext, ExecutionResult, ProviderExecutors, ResolvedCredential } from "../core/types";

import { CastError, optionalRecord, optionalString } from "../core/cast";
import { createGuardedFetch } from "../core/guarded-fetch";

/**
 * Fetch-compatible function accepted by provider runtime helpers and tests.
 */
export type ProviderFetch = typeof fetch;

export interface ProviderFetchOptions {
  /** Base transport; defaults to the global fetch. A guarded fetch is unwrapped so guards never stack. */
  fetch?: ProviderFetch;
  /** Allow private-network targets for this provider's egress (see `assertPublicHttpUrl`); default public-only. */
  allowPrivateNetwork?: () => boolean;
  /**
   * Skip the DNS resolved-address check (URL and redirect guards still apply).
   * Only pass for providers whose egress host is a hardcoded literal, never
   * derived from user/credential input.
   */
  skipDnsValidation?: boolean;
  /** Additional credential-bearing headers to strip from cross-origin redirects. */
  additionalSensitiveHeaders?: readonly string[];
}

/**
 * Create the SSRF-guarded fetch used for all provider egress: the request URL,
 * every redirect hop, and (when DNS is available) every resolved address are
 * validated against the shared public-URL policy, so a provider-reachable URL
 * cannot redirect or resolve into loopback/link-local/metadata/private targets.
 */
export function createProviderFetch(options: ProviderFetchOptions = {}): ProviderFetch {
  return createGuardedFetch({
    fetch: options.fetch,
    allowPrivateNetwork: options.allowPrivateNetwork,
    skipDnsValidation: options.skipDnsValidation,
    additionalSensitiveHeaders: options.additionalSensitiveHeaders,
    mapTransportError: (error) =>
      error instanceof TypeError
        ? new ProviderRequestError(502, `provider network request failed${describeTransportCauseCode(error)}`)
        : error,
    createError: (message) => new ProviderRequestError(502, message),
  });
}

/**
 * Shared public-only SSRF-guarded fetch for provider egress. Providers that
 * hardcode their hosts may build a cheaper one via {@link createProviderFetch}.
 */
export const providerFetch: ProviderFetch = createProviderFetch();

/**
 * Provider-native handler shape. The provider owns `TContext`; the shared
 * runtime only adapts it to the action executor contract.
 */
export type ProviderRuntimeHandler<TContext> = (input: Record<string, unknown>, context: TContext) => Promise<unknown>;

export type ProviderActionHandlers<TService extends string, THandler> = Record<
  string,
  THandler
>;

/**
 * Runtime context factory used before invoking one provider-native handler.
 */
export type ProviderRuntimeContextFactory<TContext> = (
  context: ExecutionContext,
  fetcher: ProviderFetch,
) => Promise<TContext> | TContext;

export interface ProviderExecutorDefinition<TContext> {
  service: string;
  handlers: Record<string, ProviderRuntimeHandler<TContext>>;
  createContext: ProviderRuntimeContextFactory<TContext>;
  fallbackMessage?: string;
  /** Override the standard execution-error mapping when the provider exposes stable native error codes. */
  mapError?: (error: unknown) => ExecutionResult;
  /** Deployment-gated private-network opt-in applied to this provider's egress fetch. */
  allowPrivateNetwork?: () => boolean;
  /** Skip the redundant DNS resolved-address check; only for hardcoded-host providers. */
  skipDnsValidation?: boolean;
}

/**
 * Error raised for provider API responses and mapped to stable execution errors.
 */
export class ProviderRequestError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/**
 * Map provider runtime failures to the standard action execution result.
 */
function toProviderExecutionError(error: unknown, fallbackMessage: string): ExecutionResult {
  // 用户中断 run 的 AbortError 不能塌缩成 internal_error——模型会把中止误读为 provider 故障
  if (error instanceof Error && error.name === "AbortError") {
    return { ok: false, error: { code: "cancelled", message: "Request cancelled." } };
  }
  // ConnectorError(凭证缺失/刷新失败等)直通稳定 code:「请重新授权」类问题
  // 不能塌缩成 internal_error,否则调用方无法自纠
  if (
    error instanceof Error &&
    error.name === "ConnectorError" &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return {
      ok: false,
      error: {
        code: (error as unknown as { code: string }).code,
        message: error.message,
      },
    };
  }
  if (error instanceof ProviderRequestError) {
    return {
      ok: false,
      error: {
        code:
          error.status === 401 || error.status === 403
            ? "authorization_failed"
            : error.status === 429
              ? "rate_limited"
              : error.status < 500
                ? "invalid_input"
                : "provider_error",
        message: error.message,
        details: {
          status: error.status,
          details: error.details,
        },
      },
    };
  }
  if (error instanceof CastError) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: error.message,
      },
    };
  }

  return {
    ok: false,
    error: {
      code: "internal_error",
      message: fallbackMessage,
    },
  };
}

/**
 * Adapt a provider-native handler map to full action-id executors.
 *
 * Provider modules should keep action handlers keyed by provider-local action
 * names. The runtime adds the service prefix and returns `undefined` through
 * `ProviderLoader` when a catalog action has no local executor.
 */
export function defineProviderExecutors<TContext>(input: ProviderExecutorDefinition<TContext>): ProviderExecutors {
  const executors: ProviderExecutors = {};
  const fallbackMessage = input.fallbackMessage ?? "provider request failed";
  const egressFetch =
    input.allowPrivateNetwork || input.skipDnsValidation
      ? createProviderFetch({
          allowPrivateNetwork: input.allowPrivateNetwork,
          skipDnsValidation: input.skipDnsValidation,
        })
      : providerFetch;
  for (const [name, handler] of Object.entries(input.handlers)) {
    executors[`${input.service}.${name}`] = async (actionInput, executionContext): Promise<ExecutionResult> => {
      try {
        return {
          ok: true,
          output: await handler(
            actionInput as Record<string, unknown>,
            await input.createContext(executionContext, egressFetch),
          ),
        };
      } catch (error) {
        return input.mapError?.(error) ?? toProviderExecutionError(error, fallbackMessage);
      }
    };
  }

  return executors;
}

/**
 * Return a configured OAuth credential for a provider or throw an execution
 * error before making provider API calls.
 */
export async function requireOAuthCredential(
  context: ExecutionContext,
  service: string,
): Promise<Extract<ResolvedCredential, { authType: "oauth2" }>> {
  const credential = await context.getCredential(service);
  if (credential?.authType === "oauth2") {
    return credential;
  }

  throw new ProviderRequestError(401, `Connect ${service} with OAuth first.`);
}

/**
 * Return configured custom credential values for a provider.
 */
export async function requireCustomCredential(
  context: ExecutionContext,
  service: string,
): Promise<Extract<ResolvedCredential, { authType: "custom_credential" }>> {
  const credential = await context.getCredential(service);
  if (credential?.authType === "custom_credential") {
    return credential;
  }

  throw new ProviderRequestError(401, `Configure ${service} custom credentials first.`);
}

/**
 * The platform error code behind a transport failure (`ENOTFOUND`,
 * `ECONNREFUSED`, `CERT_HAS_EXPIRED`, ...), formatted for appending to a
 * provider-visible message, or `""` when there is none.
 *
 * Only the code — never `cause.message`, which on undici embeds the target host
 * (`getaddrinfo ENOTFOUND secret.internal`). That host is exactly what the
 * transport-error mapping exists to keep out of provider-visible errors; the
 * code is an enum-like token that identifies the failure without naming it.
 */
function describeTransportCauseCode(error: unknown): string {
  const code = optionalString(optionalRecord(optionalRecord(error)?.cause)?.code);
  return code ? ` (${code})` : "";
}
