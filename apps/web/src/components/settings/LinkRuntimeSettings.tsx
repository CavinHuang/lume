import { useEffect, useState } from "react";
import type { LinkRuntimeDiagnostic, LinkRuntimeMode, LinkRuntimeState } from "@lume/shared";
import { Cloud, KeyRound, Laptop } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import {
  changeLinkRuntimePort,
  configureLinkRuntime,
  diagnoseLinkRuntime,
  disableLinkRuntime,
  enableLinkRuntime,
  getLinkRuntimeState,
  onLinkRuntimeState,
  restartLinkRuntime,
} from "@/lib/desktop-api";

export function LinkRuntimeSettings() {
  const [state, setState] = useState<LinkRuntimeState | null>(null);
  const [mode, setMode] = useState<LinkRuntimeMode>("local");
  const [port, setPort] = useState("");
  const [remoteOrigin, setRemoteOrigin] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [runtimeToken, setRuntimeToken] = useState("");
  const [clearAdminToken, setClearAdminToken] = useState(false);
  const [clearRuntimeToken, setClearRuntimeToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmPort, setConfirmPort] = useState(false);
  const [diagnostic, setDiagnostic] = useState<LinkRuntimeDiagnostic | null>(null);

  const applyState = (value: LinkRuntimeState) => {
    setState(value);
    setMode(value.mode);
    setPort(value.port ? String(value.port) : "");
    setRemoteOrigin(value.remoteOrigin ?? "");
  };

  useEffect(() => {
    void getLinkRuntimeState().then(applyState).catch(() => toast.error("无法读取 Link 运行时状态"));
    let unsubscribe: (() => void) | undefined;
    void onLinkRuntimeState(applyState).then((off) => { unsubscribe = off; });
    return () => unsubscribe?.();
  }, []);

  const run = async (operation: () => Promise<LinkRuntimeState>, success?: string) => {
    setBusy(true);
    try {
      applyState(await operation());
      setDiagnostic(null);
      if (success) toast.success(success);
      return true;
    } catch (error) {
      toast.error(linkErrorMessage(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveMode = () => {
    if (mode === "local") {
      void run(() => configureLinkRuntime({ mode: "local" }), "已切换到本机内置服务");
      return;
    }
    const origin = remoteOrigin.trim();
    if (!origin) { toast.error("请输入已有部署的 API 地址"); return; }
    void run(
      () => configureLinkRuntime({
        mode: "remote",
        origin,
        ...(clearAdminToken ? { clearAdminToken: true } : adminToken.trim() ? { adminToken } : {}),
        ...(clearRuntimeToken ? { clearRuntimeToken: true } : runtimeToken.trim() ? { runtimeToken } : {}),
      }),
      "已有部署已保存并连接",
    ).then((saved) => {
      if (saved) {
        setAdminToken("");
        setRuntimeToken("");
        setClearAdminToken(false);
        setClearRuntimeToken(false);
      }
    });
  };

  if (!state) return <div className="lume-panel p-5 text-sm text-muted-foreground">正在读取 Link 运行时…</div>;

  const selectedModeActive = state.mode === mode;
  return (
    <div className="lume-panel space-y-5 p-5">
      <div>
        <div className="text-sm font-medium">OpenConnector 服务</div>
        <p className="mt-1 text-xs text-muted-foreground">
          使用 Lume 内置服务，或连接一套已经部署好的 OpenConnector。
        </p>
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-2 text-xs font-medium text-muted-foreground">部署方式</legend>
        <div role="radiogroup" aria-label="部署方式" className="grid gap-2 sm:grid-cols-2">
          <ModeOption
            active={mode === "local"}
            icon={<Laptop className="size-4" />}
            title="本机内置"
            description="由 Lume 启动和维护本机 OpenConnector 服务。"
            disabled={busy}
            onClick={() => setMode("local")}
          />
          <ModeOption
            active={mode === "remote"}
            icon={<Cloud className="size-4" />}
            title="已有部署"
            description="连接你的服务器，不启动或维护本机服务。"
            disabled={busy}
            onClick={() => setMode("remote")}
          />
        </div>
      </fieldset>

      {mode === "remote" ? (
        <div className="space-y-4">
          <label className="grid gap-1.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">OpenConnector API 地址</span>
            <Input
              value={remoteOrigin}
              placeholder="https://openconnector.example.com"
              disabled={busy}
              onChange={(event) => setRemoteOrigin(event.target.value)}
            />
            <span>公网地址必须使用 HTTPS；本机已有服务可以使用 HTTP。</span>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <TokenField
              label="Admin Token"
              value={adminToken}
              configured={state.adminTokenConfigured}
              clear={clearAdminToken}
              description="用于在 Lume 中配置 Provider、连接账号和授权。"
              disabled={busy}
              onChange={(value) => { setAdminToken(value); setClearAdminToken(false); }}
              onClearChange={setClearAdminToken}
            />
            <TokenField
              label="Runtime Token"
              value={runtimeToken}
              configured={state.runtimeTokenConfigured}
              clear={clearRuntimeToken}
              description="用于 Agent 调用 OpenConnector 的 MCP 工具。"
              disabled={busy}
              onChange={(value) => { setRuntimeToken(value); setClearRuntimeToken(false); }}
              onClearChange={setClearRuntimeToken}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            未启用对应鉴权时可以留空；已保存的 Token 会加密保管，留空保持现有值，也可以显式清除。
          </p>
        </div>
      ) : (
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <Info label="版本" value={state.version} />
          <Info label="数据目录" value={state.dataDirectory} />
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 p-3">
        <div>
          <div className="text-sm font-medium">{state.enabled ? "服务已启用" : "服务已停用"}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            当前状态：{phaseLabel(state.phase)}{state.origin ? ` · ${state.origin}` : ""}
          </p>
        </div>
        <Switch
          checked={state.enabled}
          disabled={busy || !selectedModeActive}
          onCheckedChange={(checked) => void run(checked ? enableLinkRuntime : disableLinkRuntime)}
        />
      </div>

      {state.lastError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">{linkErrorMessage(state.lastError)}</div>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <Button disabled={busy || (mode === "remote" && !remoteOrigin.trim())} onClick={saveMode}>
          {mode === "remote" ? "保存并连接" : state.mode === "local" ? "应用本机模式" : "切换到本机模式"}
        </Button>
        {mode === "local" && state.mode === "local" && (
          <>
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>固定高位端口（49152–65535）</span>
              <Input className="w-40" value={port} onChange={(event) => setPort(event.target.value)} />
            </label>
            <Button variant="outline" disabled={busy || Number(port) === state.port} onClick={() => setConfirmPort(true)}>更改端口</Button>
          </>
        )}
        <Button variant="outline" disabled={busy || !state.enabled || !selectedModeActive} onClick={() => void run(restartLinkRuntime)}>
          {state.mode === "remote" ? "重新连接" : "重启"}
        </Button>
        <Button
          variant="outline"
          disabled={busy || !selectedModeActive}
          onClick={() => {
            setBusy(true);
            void diagnoseLinkRuntime().then(setDiagnostic).catch((error) => toast.error(error instanceof Error ? error.message : "诊断失败")).finally(() => setBusy(false));
          }}
        >
          运行诊断
        </Button>
      </div>

      {diagnostic && (
        <div className="rounded-md border p-3 text-xs">
          <div className="font-medium">最近诊断 · {diagnostic.checkedAt}</div>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            {state.mode === "local" && <Info label="资源完整" value={diagnostic.resourceReady ? "是" : "否"} />}
            {state.mode === "local" && <Info label="数据目录" value={diagnostic.dataDirectoryReady ? "可用" : "未创建"} />}
            <Info label="健康端点" value={diagnostic.endpointReachable ? `正常${diagnostic.latencyMs == null ? "" : ` · ${diagnostic.latencyMs}ms`}` : "不可达"} />
          </div>
          {diagnostic.error && <div className="mt-2 text-destructive">{diagnostic.error}</div>}
        </div>
      )}

      <ConfirmDialog
        open={confirmPort}
        onOpenChange={setConfirmPort}
        title="更改 Link 端口？"
        description="这会重启本机运行时，并改变 OAuth 回调地址。"
        confirmLabel="更改并重启"
        onConfirm={() => void run(() => changeLinkRuntimePort(Number(port)))}
      />
    </div>
  );
}

function ModeOption({ active, icon, title, description, disabled, onClick }: { active: boolean; icon: React.ReactNode; title: string; description: string; disabled: boolean; onClick: () => void }) {
  return (
    <Button
      type="button"
      role="radio"
      aria-checked={active}
      variant="outline"
      disabled={disabled}
      className={cn("h-auto items-start justify-start gap-3 whitespace-normal px-3 py-3 text-left", active && "border-primary/50 bg-primary/5 hover:bg-primary/5")}
      onClick={onClick}
    >
      <span className={cn("grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground", active && "bg-primary/10 text-primary")}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs font-normal leading-4 text-muted-foreground">{description}</span>
      </span>
    </Button>
  );
}

function TokenField({ label, value, configured, clear, description, disabled, onChange, onClearChange }: { label: string; value: string; configured: boolean; clear: boolean; description: string; disabled: boolean; onChange: (value: string) => void; onClearChange: (clear: boolean) => void }) {
  return (
    <div className="grid gap-1.5 text-xs text-muted-foreground">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-medium text-foreground"><KeyRound className="size-3.5" />{label}</span>
        {configured ? (
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onClearChange(!clear)}>
            {clear ? "取消清除" : "清除已保存"}
          </Button>
        ) : null}
      </div>
      <Input type="password" autoComplete="off" value={value} placeholder={clear ? "保存后清除" : configured ? "已安全保存，留空保持不变" : "可选"} disabled={disabled || clear} onChange={(event) => onChange(event.target.value)} />
      <span>{description}</span>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 break-all font-mono text-xs">{value}</div></div>;
}

function phaseLabel(phase: LinkRuntimeState["phase"]): string {
  return ({
    disabled: "已停用",
    starting: "连接中",
    online: "在线",
    stopping: "正在停止",
    offline: "离线",
    crashed: "异常退出",
    port_conflict: "端口冲突",
    incompatible: "本机资源不可用",
  } satisfies Record<LinkRuntimeState["phase"], string>)[phase];
}

function linkErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Link 操作失败";
  return ({
    invalid_link_remote_origin: "API 地址无效：公网部署请使用 HTTPS，本机服务可使用 HTTP。",
    link_health_timeout: "无法连接 OpenConnector，请检查地址、服务状态和 Runtime Token。",
    link_admin_access_failed: "无法使用 Admin Token 访问 OpenConnector 管理接口，请检查 Token。",
    connection_vault_locked: "连接保管库尚未解锁，暂时无法保存凭据。",
    link_remote_credential_origin_mismatch: "已保存的凭据与当前地址不匹配，请重新输入 Token。",
  } as Record<string, string>)[message] ?? message;
}
