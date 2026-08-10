import { useEffect, useState } from "react";
import { toast } from "sonner";
import type {
  LinkConnectionSummary, LinkCredentialField, LinkOAuthConfigSummary, LinkOAuthSession, LinkProviderDetail,
} from "@lume/shared";
import {
  cancelLinkOAuth, getLinkAction, getLinkOAuthStatus, listLinkOAuthSessions, openExternal,
  saveLinkOAuthConfig, startLinkOAuth, upsertLinkConnection,
} from "@/lib/desktop-api";
import { authLabel, credentialFields } from "@/lib/link-auth";
import { previewValue, TOOL_OUTPUT_PREVIEW_LIMIT } from "@/lib/tool-output-preview";
import { Badge } from "@/components/ui/badge";
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
  connections,
  onClose,
  onSaved,
  onReconnect,
  onRequestDelete,
}: {
  provider: LinkProviderDetail | null;
  initialConnectionName: string;
  oauthConfig?: LinkOAuthConfigSummary;
  connections: LinkConnectionSummary[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  onReconnect: (connectionName: string) => void;
  onRequestDelete: (connectionName: string) => void;
}) {
  const [connectionName, setConnectionName] = useState("default");
  const [authIndex, setAuthIndex] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [oauth, setOAuth] = useState<LinkOAuthSession | null>(null);
  const [actionDetail, setActionDetail] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setValues(oauthConfig?.clientId ? { clientId: oauthConfig.clientId } : {});
    setConnectionName(initialConnectionName);
    setAuthIndex(0);
    setOAuth(null);
    setActionDetail(null);
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
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ProviderIcon service={provider.service} displayName={provider.displayName} iconUrl={provider.iconUrl} size={20} />
            {provider.displayName}
          </DialogTitle>
          <DialogDescription>
            {provider.description || provider.service}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
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
          {connections.length > 0 && (
            <div className="space-y-2 border-t pt-3">
              <div className="text-sm font-medium">已连接账户（{connections.length}）</div>
              <div className="max-h-40 space-y-1 overflow-auto">
                {connections.map((conn) => (
                  <div key={conn.connectionName} className="lume-panel flex items-center justify-between gap-2 rounded p-2 text-xs">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1 font-medium">
                        <span className="truncate">{conn.connectionName}</span>
                        {conn.default && <Badge variant="secondary">默认</Badge>}
                      </div>
                      <div className="truncate text-muted-foreground">
                        {conn.profile?.displayName || conn.profile?.accountId || authLabel(conn.authType)}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button variant="ghost" size="sm" onClick={() => onReconnect(conn.connectionName)}>重连</Button>
                      <Button variant="ghost" size="sm" onClick={() => onRequestDelete(conn.connectionName)}>断开</Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {provider.actions && provider.actions.length > 0 && (
            <div className="space-y-2 border-t pt-3">
              <div className="text-sm font-medium">Actions（{provider.actions.length}）</div>
              <div className="max-h-36 space-y-1 overflow-auto">
                {provider.actions.map((action) => (
                  <Button
                    key={action.id}
                    variant="ghost"
                    size="sm"
                    className="h-auto w-full justify-start px-2 py-1.5 text-left"
                    onClick={() => void getLinkAction(action.id).then(setActionDetail).catch(() => toast.error("无法读取 Action 详情"))}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-xs">{action.id}</span>
                      {action.description && <span className="block truncate text-xs text-muted-foreground">{action.description}</span>}
                    </span>
                  </Button>
                ))}
              </div>
              {actionDetail != null && (
                <DetailPreview value={actionDetail} bodyClass="max-h-40" />
              )}
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

function DetailPreview({ value, bodyClass }: { value: unknown; bodyClass: string }) {
  const preview = previewValue(value);
  return (
    <div className="space-y-1">
      <pre className={`overflow-auto rounded-md border bg-background p-3 text-xs whitespace-pre-wrap ${bodyClass}`}>
        {preview.text}
      </pre>
      {preview.truncated && (
        <div className="text-xs text-muted-foreground">
          结果过长，已截断到 {TOOL_OUTPUT_PREVIEW_LIMIT.toLocaleString()} 字符。
        </div>
      )}
    </div>
  );
}
