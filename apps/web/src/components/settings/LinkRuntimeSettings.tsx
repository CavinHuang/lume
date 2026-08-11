import { useEffect, useState } from "react";
import type { LinkRuntimeDiagnostic, LinkRuntimeState } from "@lume/shared";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  changeLinkRuntimePort,
  diagnoseLinkRuntime,
  disableLinkRuntime,
  enableLinkRuntime,
  getLinkRuntimeState,
  onLinkRuntimeState,
  restartLinkRuntime,
} from "@/lib/desktop-api";

export function LinkRuntimeSettings() {
  const [state, setState] = useState<LinkRuntimeState | null>(null);
  const [port, setPort] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmPort, setConfirmPort] = useState(false);
  const [diagnostic, setDiagnostic] = useState<LinkRuntimeDiagnostic | null>(null);
  useEffect(() => {
    void getLinkRuntimeState()
      .then((value) => {
        setState(value);
        setPort(value.port ? String(value.port) : "");
      })
      .catch(() => toast.error("无法读取 Link 运行时状态"));
    let unsubscribe: (() => void) | undefined;
    void onLinkRuntimeState((value) => {
      setState(value);
      setPort(value.port ? String(value.port) : "");
    }).then((off) => {
      unsubscribe = off;
    });
    return () => unsubscribe?.();
  }, []);
  const run = async (operation: () => Promise<LinkRuntimeState>) => {
    setBusy(true);
    try {
      setState(await operation());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Link 操作失败");
    } finally {
      setBusy(false);
    }
  };
  if (!state)
    return (
      <div className="lume-panel p-5 text-sm text-muted-foreground">
        正在读取本地运行时…
      </div>
    );
  return (
    <div className="lume-panel space-y-5 p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-medium">启用本地 OpenConnector Link</div>
          <p className="mt-1 text-xs text-muted-foreground">
            仅监听 127.0.0.1，凭据由 Lume 连接保管库加密。
          </p>
        </div>
        <Switch
          checked={state.enabled}
          disabled={busy}
          onCheckedChange={(checked) =>
            void run(checked ? enableLinkRuntime : disableLinkRuntime)
          }
        />
      </div>
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <Info label="状态" value={state.phase} />
        <Info label="版本" value={state.version} />
        <Info label="重启计数" value={String(state.restartCount)} />
        <Info label="数据目录" value={state.dataDirectory} />
      </div>
      {state.lastError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          {state.lastError}
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>固定高位端口（49152–65535）</span>
          <Input
            className="w-40"
            value={port}
            onChange={(event) => setPort(event.target.value)}
          />
        </label>
        <Button
          variant="outline"
          disabled={busy || Number(port) === state.port}
          onClick={() => setConfirmPort(true)}
        >
          更改端口
        </Button>
        <Button
          variant="outline"
          disabled={busy || !state.enabled}
          onClick={() => void run(restartLinkRuntime)}
        >
          重启
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void diagnoseLinkRuntime()
              .then(setDiagnostic)
              .catch((error) => toast.error(error instanceof Error ? error.message : "诊断失败"))
              .finally(() => setBusy(false));
          }}
        >
          运行诊断
        </Button>
      </div>
      {diagnostic && (
        <div className="rounded-md border p-3 text-xs">
          <div className="font-medium">最近诊断 · {diagnostic.checkedAt}</div>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <Info label="资源完整" value={diagnostic.resourceReady ? "是" : "否"} />
            <Info label="数据目录" value={diagnostic.dataDirectoryReady ? "可用" : "未创建"} />
            <Info label="健康端点" value={diagnostic.endpointReachable ? `正常${diagnostic.latencyMs == null ? "" : ` · ${diagnostic.latencyMs}ms`}` : "不可达"} />
          </div>
          {diagnostic.error && <div className="mt-2 text-destructive">{diagnostic.error}</div>}
        </div>
      )}
      <ConfirmDialog
        open={confirmPort}
        onOpenChange={setConfirmPort}
        title="更改 Link 端口？"
        description="这会重启本地运行时，并改变 OAuth 回调地址。"
        confirmLabel="更改并重启"
        onConfirm={() => void run(() => changeLinkRuntimePort(Number(port)))}
      />
    </div>
  );
}
function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 break-all font-mono text-xs">{value}</div>
    </div>
  );
}
