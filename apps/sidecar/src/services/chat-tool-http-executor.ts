import type { ChatToolMeta } from "@lume/shared";

interface ExecuteHttpChatToolInput {
  userMessage: string;
  credentials?: Record<string, string>;
  timeoutMs?: number;
}

type TemplateVariables = Record<string, string>;

function resolveTemplateValue(key: string, variables: TemplateVariables): string {
  if (Object.prototype.hasOwnProperty.call(variables, key)) {
    return variables[key] ?? "";
  }
  if (key.startsWith("credential.")) {
    const credentialKey = key.slice("credential.".length);
    return variables[`credential.${credentialKey}`] ?? "";
  }
  return "";
}

function renderTemplate(template: string, variables: TemplateVariables, encode = false): string {
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, rawKey: string) => {
    const value = resolveTemplateValue(rawKey.trim(), variables);
    return encode ? encodeURIComponent(value) : value;
  });
}

function extractByPath(payload: unknown, path?: string): unknown {
  if (!path || path.trim().length === 0) return payload;
  const segments = path.split(".").map((item) => item.trim()).filter((item) => item.length > 0);
  let current: unknown = payload;
  for (const segment of segments) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function toTextResult(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export async function executeHttpChatTool(
  meta: ChatToolMeta,
  input: ExecuteHttpChatToolInput
): Promise<string> {
  if (meta.executorType !== "http" || !meta.httpConfig) {
    throw new Error(`工具 ${meta.id} 尚未配置 HTTP 执行器`);
  }

  const credentials = input.credentials ?? {};
  const variables: TemplateVariables = {
    userMessage: input.userMessage,
    query: input.userMessage,
    message: input.userMessage
  };
  for (const [key, value] of Object.entries(credentials)) {
    variables[key] = value;
    variables[`credential.${key}`] = value;
  }

  const url = renderTemplate(meta.httpConfig.urlTemplate, variables, true);
  const headers = Object.fromEntries(
    Object.entries(meta.httpConfig.headers ?? {})
      .map(([key, value]) => [key, renderTemplate(value, variables)])
  );
  const method = meta.httpConfig.method;
  const requestInit: RequestInit = {
    method,
    headers
  };

  if (method === "POST") {
    if (!headers["content-type"]) {
      headers["content-type"] = "application/json";
    }
    requestInit.body = meta.httpConfig.bodyTemplate
      ? renderTemplate(meta.httpConfig.bodyTemplate, variables)
      : JSON.stringify({ query: input.userMessage });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 12_000);
  try {
    const response = await fetch(url, {
      ...requestInit,
      signal: controller.signal
    });
    if (!response.ok) {
      const content = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}${content ? `: ${content.slice(0, 300)}` : ""}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const payload = await response.json() as unknown;
      const extracted = extractByPath(payload, meta.httpConfig.resultPath);
      const text = toTextResult(extracted ?? payload).trim();
      return text || "请求成功，未返回可展示内容。";
    }

    const text = (await response.text()).trim();
    return text || "请求成功，未返回可展示内容。";
  } finally {
    clearTimeout(timer);
  }
}
