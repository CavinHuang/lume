import { useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, KeyRound, Settings2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import type { LinkOAuthConfigSummary, LinkOAuthSession, LinkProviderDetail, LinkRuntimeMode } from "@lume/shared";
import {
  cancelLinkOAuth, getLinkOAuthStatus, listLinkOAuthSessions, openExternal,
  startLinkOAuth, upsertLinkConnection,
} from "@/lib/desktop-api";
import { authLabel, credentialFields } from "@/lib/link-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ProviderIcon } from "./ProviderIcon";
import { SecretField } from "./secret-field";
import { findRestorableLinkOAuthSession, isValidLinkConnectionName } from "./link-provider-state";

interface LinkAccountConnectDialogProps {
  provider: LinkProviderDetail;
  initialConnectionName: string;
  initialAuthType?: string;
  mode: "create" | "reconnect";
  existingConnectionNames: string[];
  oauthConfig?: LinkOAuthConfigSummary;
  runtimeMode: LinkRuntimeMode;
  onClose: () => void;
  onConfigureProvider: (connectionName: string, authType: string) => void;
  onSaved: () => Promise<void>;
}

export function LinkAccountConnectDialog({
  provider,
  initialConnectionName,
  initialAuthType,
  mode,
  existingConnectionNames,
  oauthConfig,
  runtimeMode,
  onClose,
  onConfigureProvider,
  onSaved,
}: LinkAccountConnectDialogProps) {
  const [connectionName, setConnectionName] = useState(initialConnectionName);
  const [authIndex, setAuthIndex] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [oauth, setOAuth] = useState<LinkOAuthSession | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const nextAuthIndex = initialAuthType
      ? provider.auth.findIndex((auth) => auth.type === initialAuthType)
      : -1;
    setConnectionName(initialConnectionName);
    setAuthIndex(nextAuthIndex >= 0 ? nextAuthIndex : 0);
    setValues({});
    setOAuth(null);
    if (initialAuthType && initialAuthType !== "oauth2") return;
    let active = true;
    void listLinkOAuthSessions()
      .then((sessions) => {
        if (!active) return;
        const session = findRestorableLinkOAuthSession(sessions, provider.service, initialConnectionName);
        setOAuth(session ?? null);
        if (session) {
          setConnectionName(session.connectionName);
          const oauthIndex = provider.auth.findIndex((auth) => auth.type === "oauth2");
          if (oauthIndex >= 0) setAuthIndex(oauthIndex);
        }
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [provider.service, initialConnectionName, initialAuthType]);

  useEffect(() => {
    if (!oauth || oauth.status !== "pending") return;
    const timer = setInterval(
      () => void getLinkOAuthStatus(oauth.state)
        .then((next) => {
          setOAuth(next);
          if (next.status === "authorized") void onSaved();
        })
        .catch((error) => setOAuth({
          ...oauth,
          status: "error",
          error: error instanceof Error ? error.message : "授权失败",
        })),
      1500,
    );
    return () => clearInterval(timer);
  }, [oauth, onSaved]);

  const auth = provider.auth[authIndex] ?? provider.auth[0] ?? { type: "no_auth" as const };
  const fields = credentialFields(auth);
  const isOAuth = auth.type === "oauth2";
  const oauthReady = !isOAuth || (oauthConfig?.configured ?? false);
  const fieldsReady = fields.every((field) => !field.required || Boolean(values[field.key]?.trim()));
  const connectionNameValid = isValidLinkConnectionName(connectionName);
  const connectionNameDuplicate = mode === "create" && existingConnectionNames.includes(connectionName.trim());
  const canSave = connectionNameValid && !connectionNameDuplicate && oauthReady && fieldsReady;
  const submitLabel = isOAuth
    ? mode === "reconnect" ? "在浏览器中重新授权" : "在浏览器中授权"
    : mode === "reconnect" ? "更新账户连接" : "保存账户连接";
  const runtimeLabel = runtimeMode === "remote" ? "已有部署的 Link 运行时" : "本机 Link 运行时";

  const save = async () => {
    setBusy(true);
    try {
      const normalizedConnectionName = connectionName.trim();
      if (isOAuth) {
        const session = await startLinkOAuth(provider.service, normalizedConnectionName);
        setOAuth(session);
        await openExternal(session.authorizationUrl || "");
      } else {
        await upsertLinkConnection({
          service: provider.service,
          connectionName: normalizedConnectionName,
          authType: String(auth.type),
          credentials: Object.fromEntries(fields.map((field) => [field.key, values[field.key] ?? ""])),
        });
        setValues({});
        await onSaved();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存账户连接失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="border-b border-[var(--lume-border-subtle)] p-4 pr-12">
          <div className="flex min-w-0 items-start gap-3">
            <ProviderIcon service={provider.service} displayName={provider.displayName} iconUrl={provider.iconUrl} size={40} />
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <DialogTitle className="truncate">
                  {mode === "reconnect" ? "重新连接" : "连接"} {provider.displayName} 账户
                </DialogTitle>
                <Badge variant="secondary">{authLabel(String(auth.type))}</Badge>
              </div>
              <DialogDescription className="mt-1 leading-relaxed">
                每个账户独立保存授权；OAuth 应用配置由{runtimeLabel}统一管理。
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 space-y-5 overflow-y-auto p-4">
          <section className="grid gap-3">
            <div>
              <h3 className="text-sm font-medium text-[var(--text-1)]">账户标识</h3>
              <p className="mt-0.5 text-xs text-[var(--text-3)]">设置一个便于识别的本地名称，例如 work 或 personal。</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="link-connection-name">连接名称</Label>
              <Input
                id="link-connection-name"
                value={connectionName}
                maxLength={64}
                placeholder="例如：work"
                disabled={mode === "reconnect"}
                aria-invalid={connectionName.length > 0 && (!connectionNameValid || connectionNameDuplicate)}
                onChange={(event) => setConnectionName(event.target.value)}
              />
              <p className={connectionName.length > 0 && (!connectionNameValid || connectionNameDuplicate) ? "text-xs text-destructive" : "text-xs text-[var(--text-3)]"}>
                {connectionNameDuplicate
                  ? "这个连接名称已经存在，请为新账户使用其他名称。"
                  : connectionName.length > 0 && !connectionNameValid
                  ? "需以字母或数字开头，并且只能包含字母、数字、下划线或短横线。"
                  : mode === "reconnect"
                    ? "重新授权会更新这个账户，不会修改连接名称。"
                    : "此名称用于定位账户，最长 64 个字符。"}
              </p>
            </div>
          </section>

          <section className="grid gap-3 border-t border-[var(--lume-border-subtle)] pt-4">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium text-[var(--text-1)]">账户认证</h3>
                <p className="mt-0.5 text-xs text-[var(--text-3)]">账户凭据只会交给{runtimeLabel}保存。</p>
              </div>
              {provider.auth.length === 1 ? <Badge variant="outline">{authLabel(String(auth.type))}</Badge> : null}
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
                  <ToggleGroupItem key={`${item.type}:${index}`} value={String(index)} disabled={oauth?.status === "pending"} className="border border-[var(--lume-border-subtle)]">
                    {authLabel(String(item.type))}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            ) : null}

            {isOAuth ? (
              oauthConfig?.configured ? (
                <div className="flex items-start gap-2 rounded-md border border-[var(--lume-border-subtle)] bg-muted/30 px-3 py-2.5 text-xs text-[var(--text-3)]">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[var(--lume-success)]" />
                  <div>
                    <span className="font-medium text-[var(--text-1)]">连接器 OAuth 配置已就绪</span>
                    <br />点击授权后，将在系统浏览器中登录这个账户。
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-xs text-[var(--text-3)]">
                  <Settings2 className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  <div>
                    <span className="font-medium text-[var(--text-1)]">需要先配置 OAuth 应用</span>
                    <br />客户端配置属于连接器，不属于当前账户，完成一次配置后可连接多个账户。
                  </div>
                </div>
              )
            ) : (
              fields.map((field) => (
                <SecretField
                  key={field.key}
                  label={field.label}
                  value={values[field.key] ?? ""}
                  onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
                  secret={field.secret}
                  textarea={field.inputType === "textarea" || field.inputType === "json"}
                  required={field.required}
                  placeholder={field.placeholder}
                  description={field.description}
                />
              ))
            )}
          </section>

          {oauth ? <OAuthStatusPanel oauth={oauth} busy={busy} /> : null}
        </div>

        <DialogFooter className="m-0 rounded-none px-4 py-3">
          {oauth?.status === "pending" ? (
            <>
              {oauth.authorizationUrl ? (
                <Button variant="outline" disabled={busy} onClick={() => void openExternal(oauth.authorizationUrl || "")}>
                  <ExternalLink className="size-3.5" />重新打开浏览器
                </Button>
              ) : null}
              <Button variant="outline" disabled={busy} onClick={() => void cancelLinkOAuth(oauth.state).then(setOAuth)}>取消授权</Button>
            </>
          ) : (
            <Button variant="outline" disabled={busy} onClick={onClose}>取消</Button>
          )}
          {isOAuth && !oauthConfig?.configured ? (
            <Button disabled={busy} onClick={() => onConfigureProvider(connectionName.trim() || "default", String(auth.type))}>
              <Settings2 className="size-3.5" />配置 OAuth 应用
            </Button>
          ) : (
            <Button disabled={busy || !canSave || oauth?.status === "pending"} onClick={() => void save()}>
              {busy ? <Spinner className="size-3.5" /> : isOAuth ? <ExternalLink className="size-3.5" /> : <KeyRound className="size-3.5" />}
              {submitLabel}
            </Button>
          )}
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
