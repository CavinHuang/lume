import { useEffect, useState } from "react";
import { toast } from "sonner";
import type {
  LinkCredentialField, LinkOAuthConfigSummary, LinkOAuthSession, LinkProviderDetail,
} from "@lume/shared";
import {
  cancelLinkOAuth, getLinkOAuthStatus, listLinkOAuthSessions, openExternal,
  saveLinkOAuthConfig, startLinkOAuth, upsertLinkConnection,
} from "@/lib/desktop-api";
import { authLabel, credentialFields } from "@/lib/link-auth";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ProviderIcon } from "./ProviderIcon";
import { SecretField } from "./secret-field";

export function LinkConnectDialog({
  provider,
  initialConnectionName,
  oauthConfig,
  onClose,
  onSaved,
}: {
  provider: LinkProviderDetail | null;
  initialConnectionName: string;
  oauthConfig?: LinkOAuthConfigSummary;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [connectionName, setConnectionName] = useState("default");
  const [authIndex, setAuthIndex] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [oauth, setOAuth] = useState<LinkOAuthSession | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setValues(oauthConfig?.clientId ? { clientId: oauthConfig.clientId } : {});
    setConnectionName(initialConnectionName);
    setAuthIndex(0);
    setOAuth(null);
    if (provider?.service) {
      void listLinkOAuthSessions()
        .then((sessions) => setOAuth(sessions.find((session) => session.service === provider.service && session.status === "pending") ?? null))
        .catch(() => undefined);
    }
  }, [provider?.service, initialConnectionName, oauthConfig?.clientId]);
  useEffect(() => {
    if (!oauth || oauth.status !== "pending") return;
    const timer = setInterval(
      () =>
        void getLinkOAuthStatus(oauth.state)
          .then((next) => {
            setOAuth(next);
            if (next.status === "authorized") void onSaved();
          })
          .catch((error) =>
            setOAuth({
              ...oauth,
              status: "error",
              error: error instanceof Error ? error.message : "授权失败",
            }),
          ),
      1500,
    );
    return () => clearInterval(timer);
  }, [oauth, onSaved]);
  if (!provider) return null;
  const auth = provider.auth?.[authIndex] ?? { type: "no_auth" };
  const fields = credentialFields(auth);
  const isOAuth = auth.type === "oauth2";
  const oauthFields = credentialFields({
    fields: (oauthConfig?.auth.clientConfigFields ??
      auth.clientConfigFields) as unknown,
  }) as Array<
    LinkCredentialField & {
      location?: "extra" | "secretExtra";
      defaultValue?: string;
    }
  >;
  const save = async () => {
    setBusy(true);
    try {
      if (isOAuth) {
        const extra = Object.fromEntries(
          oauthFields
            .filter((field) => field.location !== "secretExtra")
            .map((field) => [
              field.key,
              values[field.key] ?? field.defaultValue ?? "",
            ]),
        );
        const secretExtra = Object.fromEntries(
          oauthFields
            .filter((field) => field.location === "secretExtra")
            .map((field) => [field.key, values[field.key] ?? ""]),
        );
        if (!oauthConfig?.configured || values.clientSecret || auth.tokenEndpointAuthMethod === "none")
          await saveLinkOAuthConfig(
            provider.service,
            values.clientId || "",
            values.clientSecret || "",
            extra,
            secretExtra,
          );
        const session = await startLinkOAuth(provider.service, connectionName);
        setOAuth(session);
        await openExternal(session.authorizationUrl || "");
      } else {
        await upsertLinkConnection({
          service: provider.service,
          connectionName,
          authType: String(auth.type),
          credentials: Object.fromEntries(
            fields.map((field) => [field.key, values[field.key] ?? ""]),
          ),
        });
        setValues({});
        await onSaved();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存连接失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ProviderIcon service={provider.service} displayName={provider.displayName} iconUrl={provider.iconUrl} size={20} />
            {provider.displayName}
          </DialogTitle>
          <DialogDescription>
            {provider.description || provider.service}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
          <Label>连接名称</Label>
          <Input
            value={connectionName}
            onChange={(event) => setConnectionName(event.target.value)}
          />
          <Label>认证方式</Label>
          <Select
            value={String(authIndex)}
            onValueChange={(value) => {
              setAuthIndex(Number(value ?? 0));
              setValues({});
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {provider.auth.map((item, index) => (
                <SelectItem key={`${item.type}:${index}`} value={String(index)}>
                  {authLabel(String(item.type))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {isOAuth ? (
            <>
              <SecretField
                label="OAuth Client ID"
                value={values.clientId ?? ""}
                onChange={(value) =>
                  setValues((prev) => ({ ...prev, clientId: value }))
                }
                secret={false}
              />
              <SecretField
                label="OAuth Client Secret"
                value={values.clientSecret ?? ""}
                onChange={(value) =>
                  setValues((prev) => ({ ...prev, clientSecret: value }))
                }
                secret
              />
              {oauthFields.map((field) => (
                <SecretField
                  key={field.key}
                  label={field.label}
                  value={values[field.key] ?? field.defaultValue ?? ""}
                  onChange={(value) => setValues((prev) => ({ ...prev, [field.key]: value }))}
                  secret={field.secret || field.location === "secretExtra"}
                  textarea={field.inputType === "textarea" || field.inputType === "json"}
                />
              ))}
              {oauthConfig?.expectedRedirectUri && (
                <div className="rounded-md bg-muted p-3 text-xs">
                  <div className="font-medium">OAuth 回调地址</div>
                  <div className="mt-1 break-all font-mono text-muted-foreground">{oauthConfig.expectedRedirectUri}</div>
                </div>
              )}
            </>
          ) : (
            fields.map((field) => (
              <SecretField
                key={field.key}
                label={field.label}
                value={values[field.key] ?? ""}
                onChange={(value) =>
                  setValues((prev) => ({ ...prev, [field.key]: value }))
                }
                secret={field.secret}
                textarea={
                  field.inputType === "textarea" || field.inputType === "json"
                }
              />
            ))
          )}
          {oauth && (
            <div className="rounded-md bg-muted p-3 text-xs">
              授权状态：{oauth.status}
              {oauth.error ? ` · ${oauth.error}` : ""}
            </div>
          )}
        </div>
        <DialogFooter>
          {oauth?.status === "pending" && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void cancelLinkOAuth(oauth.state).then(setOAuth)}
            >
              取消授权
            </Button>
          )}
          <Button disabled={busy || oauth?.status === "pending"} onClick={() => void save()}>
            {isOAuth ? "保存并在系统浏览器授权" : "保存连接"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
