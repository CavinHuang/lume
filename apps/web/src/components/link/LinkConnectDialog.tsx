import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, ExternalLink, KeyRound, ShieldCheck } from "lucide-react";
import type {
  LinkCredentialField, LinkOAuthConfigSummary, LinkOAuthSession, LinkProviderDetail,
} from "@lume/shared";
import {
  cancelLinkOAuth, getLinkOAuthStatus, listLinkOAuthSessions, openExternal,
  saveLinkOAuthConfig, startLinkOAuth, upsertLinkConnection,
} from "@/lib/desktop-api";
import { authLabel, credentialFields } from "@/lib/link-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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
  const oauthCustomFields = oauthFields.filter(
    (field) => field.key !== "clientId" && field.key !== "clientSecret",
  );
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
      <DialogContent className="max-h-[calc(100vh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="border-b border-[var(--lume-border-subtle)] p-4 pr-12">
          <div className="flex min-w-0 items-start gap-3">
            <ProviderIcon service={provider.service} displayName={provider.displayName} iconUrl={provider.iconUrl} size={36} />
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <DialogTitle className="truncate">连接 {provider.displayName}</DialogTitle>
                <Badge variant="secondary">{authLabel(String(auth.type))}</Badge>
              </div>
              <DialogDescription className="mt-1 leading-relaxed">
                {provider.description || `配置 ${provider.displayName} 的本地连接`}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <div className="min-h-0 space-y-5 overflow-y-auto p-4">
          <section className="grid gap-3">
            <div>
              <h3 className="text-sm font-medium text-[var(--text-1)]">连接身份</h3>
              <p className="mt-0.5 text-xs text-[var(--text-3)]">为这组凭据设置一个名称，便于在多个账户之间区分。</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="link-connection-name">连接名称</Label>
              <Input
                id="link-connection-name"
                value={connectionName}
                placeholder="例如：工作账户"
                onChange={(event) => setConnectionName(event.target.value)}
              />
            </div>
          </section>

          <section className="grid gap-3 border-t border-[var(--lume-border-subtle)] pt-4">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium text-[var(--text-1)]">认证配置</h3>
                <p className="mt-0.5 text-xs text-[var(--text-3)]">认证信息只会交给本机 Link 运行时保存。</p>
              </div>
              {provider.auth.length === 1 ? (
                <Badge variant="outline">{authLabel(String(auth.type))}</Badge>
              ) : null}
            </div>
            {provider.auth.length > 1 ? (
              <ToggleGroup
                className="justify-start"
                value={String(authIndex)}
                onValueChange={(value) => {
                  setAuthIndex(Number(value));
                  setValues({});
                  setOAuth(null);
                }}
              >
                {provider.auth.map((item, index) => (
                  <ToggleGroupItem key={`${item.type}:${index}`} value={String(index)} className="border border-[var(--lume-border-subtle)]">
                    {authLabel(String(item.type))}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            ) : null}
            {isOAuth ? (
              <>
              {oauthConfig?.configured ? (
                <div className="flex items-start gap-2 rounded-md border border-[var(--lume-border-subtle)] bg-muted/30 px-3 py-2.5 text-xs text-[var(--text-3)]">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[var(--lume-success)]" />
                  <div><span className="font-medium text-[var(--text-1)]">OAuth 客户端已配置</span><br />Client Secret 留空即可沿用现有配置。</div>
                </div>
              ) : null}
              <SecretField
                label="OAuth Client ID"
                value={values.clientId ?? ""}
                onChange={(value) =>
                  setValues((prev) => ({ ...prev, clientId: value }))
                }
                secret={false}
                required={!oauthConfig?.configured}
                placeholder="从服务商开发者后台复制 Client ID"
              />
              <SecretField
                label="OAuth Client Secret"
                value={values.clientSecret ?? ""}
                onChange={(value) =>
                  setValues((prev) => ({ ...prev, clientSecret: value }))
                }
                secret
                required={!oauthConfig?.configured && auth.tokenEndpointAuthMethod !== "none"}
                placeholder={oauthConfig?.configured ? "已配置，留空表示不修改" : "输入 Client Secret"}
              />
              {oauthCustomFields.map((field) => (
                <SecretField
                  key={field.key}
                  label={field.label}
                  value={values[field.key] ?? field.defaultValue ?? ""}
                  onChange={(value) => setValues((prev) => ({ ...prev, [field.key]: value }))}
                  secret={field.secret || field.location === "secretExtra"}
                  textarea={field.inputType === "textarea" || field.inputType === "json"}
                  required={field.required}
                  placeholder={field.placeholder}
                  description={field.description}
                />
              ))}
              {oauthConfig?.expectedRedirectUri && (
                <div className="rounded-md border border-[var(--lume-border-subtle)] bg-muted/30 p-3 text-xs">
                  <div className="font-medium text-[var(--text-1)]">OAuth 回调地址</div>
                  <div className="mt-1 break-all font-mono leading-relaxed text-[var(--text-3)]">{oauthConfig.expectedRedirectUri}</div>
                  <div className="mt-1.5 text-[var(--text-3)]">请将此地址添加到服务商应用的允许回调地址中。</div>
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
                  required={field.required}
                  placeholder={field.placeholder}
                  description={field.description}
                />
              ))
            )}
          </section>
          {oauth && (
            <OAuthStatusPanel oauth={oauth} busy={busy} />
          )}
        </div>
        <DialogFooter className="m-0 rounded-none px-4 py-3">
          {oauth?.status === "pending" && (
            <>
              {oauth.authorizationUrl ? (
                <Button variant="outline" disabled={busy} onClick={() => void openExternal(oauth.authorizationUrl || "")}>
                  <ExternalLink className="size-3.5" />重新打开浏览器
                </Button>
              ) : null}
              <Button variant="outline" disabled={busy} onClick={() => void cancelLinkOAuth(oauth.state).then(setOAuth)}>取消授权</Button>
            </>
          )}
          {oauth?.status !== "pending" ? <Button variant="outline" disabled={busy} onClick={onClose}>取消</Button> : null}
          <Button disabled={busy || oauth?.status === "pending"} onClick={() => void save()}>
            {busy ? <Spinner className="size-3.5" /> : isOAuth ? <ExternalLink className="size-3.5" /> : <KeyRound className="size-3.5" />}
            {isOAuth ? (oauthConfig?.configured ? "在浏览器中授权" : "保存并继续授权") : "保存连接"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OAuthStatusPanel({ oauth, busy }: { oauth: LinkOAuthSession; busy: boolean }) {
  const pending = oauth.status === "pending";
  const authorized = oauth.status === "authorized";
  return (
    <section className="grid gap-2 rounded-md border border-[var(--lume-border-subtle)] bg-muted/30 p-3">
      <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-1)]">
        {pending || busy ? <Spinner className="size-4" /> : authorized ? <CheckCircle2 className="size-4 text-[var(--lume-success)]" /> : <ShieldCheck className="size-4 text-destructive" />}
        {pending ? "等待浏览器授权" : authorized ? "授权完成" : "授权未完成"}
      </div>
      <p className="text-xs leading-relaxed text-[var(--text-3)]">
        {pending ? "请在系统浏览器中登录并确认授权。完成后此页面会自动更新。" : oauth.error || "你可以重新发起授权。"}
      </p>
    </section>
  );
}
