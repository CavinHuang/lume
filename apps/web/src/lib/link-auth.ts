import type { LinkCredentialField } from "@lume/shared";

export function credentialFields(auth: Record<string, unknown>): LinkCredentialField[] {
  const configured = auth.type === "api_key"
    ? [
        {
          key: "apiKey",
          label: typeof auth.label === "string" ? auth.label : "API Key",
          inputType: "password" as const,
          required: true,
          secret: true,
          ...(typeof auth.placeholder === "string" ? { placeholder: auth.placeholder } : {}),
          ...(typeof auth.description === "string" ? { description: auth.description } : {}),
        },
        ...(Array.isArray(auth.extraFields) ? auth.extraFields : []),
      ]
    : auth.fields;
  return Array.isArray(configured)
    ? configured.filter((item): item is LinkCredentialField =>
        Boolean(item && typeof item === "object" && typeof (item as LinkCredentialField).key === "string"),
      )
    : [];
}

export function authLabel(type: string): string {
  return ({ no_auth: "无需认证", api_key: "API Key", custom_credential: "自定义凭据", oauth2: "OAuth 2.0" } as Record<string, string>)[type] ?? type;
}
