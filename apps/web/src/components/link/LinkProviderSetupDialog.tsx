import { useEffect, useMemo, useState } from "react";
import { Save, Settings2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import type { LinkCredentialField, LinkOAuthConfigSummary, LinkProviderDetail, LinkRuntimeMode } from "@lume/shared";
import { saveLinkOAuthConfig } from "@/lib/desktop-api";
import { credentialFields } from "@/lib/link-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { ProviderIcon } from "./ProviderIcon";
import { SecretField } from "./secret-field";

interface LinkProviderSetupDialogProps {
  provider: LinkProviderDetail;
  oauthConfig?: LinkOAuthConfigSummary;
  runtimeMode: LinkRuntimeMode;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

export function LinkProviderSetupDialog({
  provider,
  oauthConfig,
  runtimeMode,
  onClose,
  onSaved,
}: LinkProviderSetupDialogProps) {
  const oauthAuth = provider.auth.find((auth) => auth.type === "oauth2");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const configured = oauthConfig?.configured ?? false;
  const sourceAuth = oauthConfig?.auth ?? oauthAuth;
  const tokenEndpointAuthMethod = sourceAuth?.tokenEndpointAuthMethod;
  const requiresClientSecret = tokenEndpointAuthMethod !== "none";
  const customFields = useMemo(
    () => credentialFields({ fields: sourceAuth?.clientConfigFields }).filter(
      (field) => field.key !== "clientId" && field.key !== "clientSecret",
    ) as Array<LinkCredentialField & { location?: "extra" | "secretExtra"; defaultValue?: string }>,
    [sourceAuth],
  );

  useEffect(() => {
    setValues(oauthConfig?.clientId ? { clientId: oauthConfig.clientId } : {});
  }, [provider.service, oauthConfig?.clientId]);

  if (!oauthAuth) return null;

  const customFieldsReady = customFields.every(
    (field) => !field.required || Boolean((values[field.key] ?? field.defaultValue ?? "").trim()),
  );
  const canSave = Boolean(
    values.clientId?.trim()
    && (!requiresClientSecret || values.clientSecret?.trim())
    && customFieldsReady,
  );

  const save = async () => {
    setBusy(true);
    try {
      const extra = Object.fromEntries(
        customFields
          .filter((field) => field.location !== "secretExtra")
          .map((field) => [field.key, values[field.key] ?? field.defaultValue ?? ""]),
      );
      const secretExtra = Object.fromEntries(
        customFields
          .filter((field) => field.location === "secretExtra")
          .map((field) => [field.key, values[field.key] ?? ""]),
      );
      await saveLinkOAuthConfig(
        provider.service,
        values.clientId.trim(),
        values.clientSecret ?? "",
        extra,
        secretExtra,
      );
      toast.success(`${provider.displayName} 的连接器配置已保存`);
      await onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存连接器配置失败");
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
                <DialogTitle className="truncate">配置 {provider.displayName}</DialogTitle>
                <Badge variant={configured ? "success" : "secondary"}>{configured ? "已配置" : "需要配置"}</Badge>
              </div>
              <DialogDescription className="mt-1 leading-relaxed">
                此 OAuth 应用配置由{runtimeMode === "remote" ? "已有部署的" : "本机"} Link 运行时保存，并供该连接器的所有账户共用。
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 space-y-4 overflow-y-auto p-4">
          <div className="flex items-start gap-2 rounded-md border border-[var(--lume-border-subtle)] bg-muted/30 px-3 py-2.5 text-xs text-[var(--text-3)]">
            {configured ? (
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[var(--lume-success)]" />
            ) : (
              <Settings2 className="mt-0.5 size-4 shrink-0 text-[var(--lume-accent)]" />
            )}
            <p className="leading-relaxed">
              {configured
                ? "Client Secret 等敏感信息不会显示在页面中。保存更改时需要重新输入 Client Secret。"
                : `请先在 ${provider.displayName} 的开发者后台创建 OAuth 应用，再将客户端信息填写到这里。`}
            </p>
          </div>

          {oauthConfig?.expectedRedirectUri ? (
            <div className="rounded-md border border-[var(--lume-border-subtle)] bg-muted/20 p-3 text-xs">
              <div className="font-medium text-[var(--text-1)]">OAuth 回调地址</div>
              <div className="mt-1.5 break-all font-mono leading-relaxed text-[var(--text-2)]">
                {oauthConfig.expectedRedirectUri}
              </div>
              <div className="mt-1.5 text-[var(--text-3)]">请将此地址加入服务商 OAuth 应用的允许回调地址。</div>
            </div>
          ) : null}

          <SecretField
            label="OAuth Client ID"
            value={values.clientId ?? ""}
            onChange={(value) => setValues((current) => ({ ...current, clientId: value }))}
            secret={false}
            required
            placeholder="从服务商开发者后台复制 Client ID"
          />
          {requiresClientSecret ? (
            <SecretField
              label="OAuth Client Secret"
              value={values.clientSecret ?? ""}
              onChange={(value) => setValues((current) => ({ ...current, clientSecret: value }))}
              secret
              required
              placeholder={configured ? "重新输入 Client Secret 以保存更改" : "输入 Client Secret"}
            />
          ) : null}
          {customFields.map((field) => (
            <SecretField
              key={field.key}
              label={field.label}
              value={values[field.key] ?? field.defaultValue ?? ""}
              onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
              secret={field.secret || field.location === "secretExtra"}
              textarea={field.inputType === "textarea" || field.inputType === "json"}
              required={field.required}
              placeholder={field.placeholder}
              description={field.description}
            />
          ))}
        </div>

        <DialogFooter className="m-0 rounded-none px-4 py-3">
          <Button variant="outline" disabled={busy} onClick={onClose}>取消</Button>
          <Button disabled={busy || !canSave} onClick={() => void save()}>
            {busy ? <Spinner className="size-3.5" /> : <Save className="size-3.5" />}
            {configured ? "保存更改" : "保存配置"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
