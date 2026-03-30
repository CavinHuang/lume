import { useEffect, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { AlertCircle, CheckCircle2, Download, Loader2, RefreshCw } from "lucide-react";
import { checkForUpdates, installUpdate, updateStatusAtom, updaterAvailableAtom } from "@/atoms";
import { getAppVersion } from "@/lib/app-version";
import { desktopHealthcheck, sidecarHealthcheck } from "@/lib/desktop-api/core";
import { SettingsCard, SettingsRow, SettingsSection } from "./primitives";
import { VersionHistory } from "./VersionHistory";

type HealthState = {
  desktop: string;
  sidecar: string;
};

export function AboutSettings(): React.ReactElement {
  const [updateStatus, setUpdateStatus] = useAtom(updateStatusAtom);
  const updaterAvailable = useAtomValue(updaterAvailableAtom);
  const [health, setHealth] = useState<HealthState>({ desktop: "checking", sidecar: "checking" });
  const appVersion = getAppVersion();
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    void (async () => {
      const [desktop, sidecar] = await Promise.allSettled([
        desktopHealthcheck(),
        sidecarHealthcheck()
      ]);

      setHealth({
        desktop: desktop.status === "fulfilled" && desktop.value.ok ? "ok" : "error",
        sidecar: sidecar.status === "fulfilled" && sidecar.value.ok ? "ok" : "error"
      });
    })();
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <SettingsSection title="关于 Lume" description="集成通用 AI Agent 的下一代人工智能软件">
        <SettingsCard>
          <SettingsRow label="版本">
            <span className="font-mono text-sm text-muted-foreground">{appVersion}</span>
          </SettingsRow>
          <SettingsRow label="运行时">
            <span className="text-sm text-muted-foreground">Tauri + Next.js</span>
          </SettingsRow>
          <SettingsRow label="开源协议" description="本项目遵循开源协议发布">
            <span className="text-sm text-muted-foreground">MIT</span>
          </SettingsRow>
          <SettingsRow label="项目地址">
            <a
              href="https://github.com/ErlichLiu/Lume.git"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary hover:underline"
            >
              github.com/ErlichLiu/Lume
            </a>
          </SettingsRow>
          <SettingsRow label="Lume 状态" description={`desktop: ${health.desktop} · sidecar: ${health.sidecar}`} />
        </SettingsCard>

        {updaterAvailable ? (
          <SettingsCard>
            <SettingsRow label="软件更新">
              <div className="flex items-center gap-3">
                <UpdateStatusText
                  status={updateStatus.status}
                  version={updateStatus.version}
                  error={updateStatus.error}
                />

                {updateStatus.status === "downloaded" ? (
                  <button
                    type="button"
                    onClick={() => {
                      void installUpdate().then(setUpdateStatus);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                  >
                    <Download className="h-3.5 w-3.5" />
                    立即安装
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setChecking(true);
                      setUpdateStatus({ status: "checking" });
                      void checkForUpdates()
                        .then(setUpdateStatus)
                        .finally(() => {
                          setTimeout(() => setChecking(false), 1000);
                        });
                    }}
                    disabled={checking || updateStatus.status === "checking"}
                    className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground transition-colors hover:bg-secondary/80 disabled:opacity-50"
                  >
                    {checking || updateStatus.status === "checking" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    检查更新
                  </button>
                )}
              </div>
            </SettingsRow>

            {updateStatus.status === "downloading" && updateStatus.progress ? (
              <div className="-mt-2 px-4 pb-4">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-300"
                    style={{ width: `${Math.round(updateStatus.progress.percent)}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  下载中 {Math.round(updateStatus.progress.percent)}%
                </p>
              </div>
            ) : null}
          </SettingsCard>
        ) : null}
      </SettingsSection>

      <SettingsSection title="版本历史与发布说明" description="查看近期版本更新内容（Release Notes）">
        <VersionHistory />
      </SettingsSection>
    </div>
  );
}

function UpdateStatusText(props: {
  status: string;
  version?: string;
  error?: string;
}): React.ReactElement {
  const { status, version, error } = props;

  switch (status) {
    case "checking":
      return <span className="text-xs text-muted-foreground">正在检查...</span>;
    case "available":
      return (
        <span className="flex items-center gap-1 text-xs text-primary">
          <Download className="h-3 w-3" />
          新版本 v{version} 可用
        </span>
      );
    case "downloading":
      return <span className="text-xs text-muted-foreground">正在下载更新...</span>;
    case "downloaded":
      return (
        <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-3 w-3" />
          v{version} 已就绪，重启后生效
        </span>
      );
    case "not-available":
      return (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <CheckCircle2 className="h-3 w-3" />
          已是最新版本
        </span>
      );
    case "error":
      return (
        <span className="flex items-center gap-1 text-xs text-destructive" title={error}>
          <AlertCircle className="h-3 w-3" />
          检查失败
        </span>
      );
    default:
      return <span className="text-xs text-muted-foreground">未检查</span>;
  }
}
