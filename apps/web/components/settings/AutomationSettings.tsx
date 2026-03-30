import { useEffect, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { FolderOpen, Trash2 } from "lucide-react";
import type { AutomationJob, AutomationRun } from "@lume/shared";
import {
  agentWorkspacesAtom,
  currentAgentWorkspaceIdAtom
} from "@/atoms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  createAutomationJob,
  deleteAutomationJob,
  listAutomationJobs,
  listAutomationRuns,
  runAutomationJobNow,
  updateAutomationJob
} from "@/lib/desktop-api/system";
import { SettingsCard, SettingsSection } from "./primitives";

export function AutomationSettings(): React.ReactElement {
  const workspaces = useAtomValue(agentWorkspacesAtom);
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom);
  const workspace = useMemo(
    () => workspaces.find((item) => item.id === currentWorkspaceId) ?? null,
    [workspaces, currentWorkspaceId]
  );

  const [automationJobs, setAutomationJobs] = useState<AutomationJob[]>([]);
  const [automationLoading, setAutomationLoading] = useState(false);
  const [automationBusy, setAutomationBusy] = useState(false);
  const [automationName, setAutomationName] = useState("");
  const [automationCronExpr, setAutomationCronExpr] = useState("30 8 * * 1-5");
  const [automationPrompt, setAutomationPrompt] = useState("");
  const [automationMessage, setAutomationMessage] = useState("");
  const [automationRuns, setAutomationRuns] = useState<AutomationRun[]>([]);

  const loadAutomationData = async (): Promise<void> => {
    setAutomationLoading(true);
    try {
      const [jobs, runs] = await Promise.all([
        listAutomationJobs(),
        listAutomationRuns({ limit: 20 })
      ]);
      setAutomationJobs(jobs);
      setAutomationRuns(runs);
    } catch (error) {
      console.error("[AutomationSettings] load automation jobs failed", error);
      setAutomationMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setAutomationLoading(false);
    }
  };

  useEffect(() => {
    void loadAutomationData();
  }, [currentWorkspaceId]);

  const handleCreateAutomationJob = async (): Promise<void> => {
    if (!automationName.trim() || !automationCronExpr.trim() || !automationPrompt.trim()) {
      setAutomationMessage("任务名称、Cron 表达式和提示词不能为空");
      return;
    }
    setAutomationBusy(true);
    setAutomationMessage("");
    try {
      await createAutomationJob({
        name: automationName.trim(),
        workspaceId: currentWorkspaceId ?? undefined,
        schedule: {
          type: "cron",
          cronExpr: automationCronExpr.trim()
        },
        prompt: automationPrompt.trim()
      });
      setAutomationName("");
      setAutomationPrompt("");
      setAutomationMessage("任务创建成功");
      await loadAutomationData();
    } catch (error) {
      setAutomationMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setAutomationBusy(false);
    }
  };

  const handleToggleAutomationJob = async (job: AutomationJob): Promise<void> => {
    setAutomationBusy(true);
    setAutomationMessage("");
    try {
      await updateAutomationJob({
        id: job.id,
        enabled: !job.enabled
      });
      await loadAutomationData();
    } catch (error) {
      setAutomationMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setAutomationBusy(false);
    }
  };

  const handleDeleteAutomationJob = async (job: AutomationJob): Promise<void> => {
    if (!window.confirm(`确定删除任务「${job.name}」？此操作不可恢复。`)) return;
    setAutomationBusy(true);
    setAutomationMessage("");
    try {
      await deleteAutomationJob(job.id);
      await loadAutomationData();
    } catch (error) {
      setAutomationMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setAutomationBusy(false);
    }
  };

  const handleRunAutomationJobNow = async (job: AutomationJob): Promise<void> => {
    setAutomationBusy(true);
    setAutomationMessage("");
    try {
      const run = await runAutomationJobNow(job.id);
      setAutomationMessage(`任务已触发: ${run.status}`);
      await loadAutomationData();
    } catch (error) {
      setAutomationMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setAutomationBusy(false);
    }
  };

  if (!workspace) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <FolderOpen size={48} className="mb-4 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">请先在 Agent 模式下选择或创建一个工作区</p>
      </div>
    );
  }

  const workspaceAutomationJobs = automationJobs.filter(
    (job) => !job.workspaceId || job.workspaceId === currentWorkspaceId
  );
  const workspaceAutomationRuns = automationRuns.filter((run) =>
    workspaceAutomationJobs.some((job) => job.id === run.jobId)
  );

  return (
    <div className="space-y-8">
      <SettingsSection title="自动化任务" description={`工作区: ${workspace.name} · 支持 Cron 定时任务的创建、启停与执行`}>
        <SettingsCard divided={false}>
          <div className="space-y-3 p-3 text-sm">
            <div className="grid gap-2">
              <Input
                value={automationName}
                onChange={(event) => setAutomationName(event.target.value)}
                placeholder="任务名称，例如：工作日早报准备"
              />
              <Input
                value={automationCronExpr}
                onChange={(event) => setAutomationCronExpr(event.target.value)}
                placeholder="Cron 表达式，例如：30 8 * * 1-5"
              />
              <textarea
                value={automationPrompt}
                onChange={(event) => setAutomationPrompt(event.target.value)}
                placeholder="执行提示词，例如：汇总昨天工作区代码变更并生成早报"
                rows={4}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              />
              <div className="flex justify-end">
                <Button size="sm" type="button" disabled={automationBusy} onClick={() => { void handleCreateAutomationJob(); }}>
                  创建任务
                </Button>
              </div>
            </div>
            <div className="rounded-md border bg-muted/20 p-3">
              <p className="font-medium">任务列表（当前工作区）</p>
              {automationLoading ? (
                <p className="mt-2 text-muted-foreground">加载中...</p>
              ) : workspaceAutomationJobs.length === 0 ? (
                <p className="mt-2 text-muted-foreground">暂无任务</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {workspaceAutomationJobs.map((job) => (
                    <div key={job.id} className="rounded-md border bg-background/80 p-2">
                      <p className="font-medium">{job.name}</p>
                      <p className="text-xs text-muted-foreground">
                        Cron: {job.schedule.cronExpr ?? "-"} · 更新时间: {new Date(job.updatedAt).toLocaleString()}
                      </p>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{job.prompt}</p>
                      <div className="mt-2 flex items-center justify-end gap-2">
                        <Switch checked={job.enabled} onCheckedChange={() => { void handleToggleAutomationJob(job); }} />
                        <Button
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={() => { void handleRunAutomationJobNow(job); }}
                        >
                          立即执行
                        </Button>
                        <Button
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={() => { void handleDeleteAutomationJob(job); }}
                        >
                          <Trash2 size={14} />
                          <span>删除</span>
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="rounded-md border bg-muted/20 p-3">
              <p className="font-medium">最近运行记录</p>
              {workspaceAutomationRuns.length === 0 ? (
                <p className="mt-2 text-muted-foreground">暂无记录</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {workspaceAutomationRuns.slice(0, 8).map((run) => (
                    <div key={run.id} className="rounded-md border bg-background/80 p-2">
                      <p className="text-xs font-medium">
                        {run.jobName} · {run.status}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        触发: {run.trigger} · {new Date(run.startedAt).toLocaleString()}
                      </p>
                      {run.sessionId ? (
                        <p className="text-xs text-muted-foreground">会话: {run.sessionId}</p>
                      ) : null}
                      <p className="mt-1 text-xs text-muted-foreground">{run.message}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {automationMessage ? <p className="text-xs text-foreground">{automationMessage}</p> : null}
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
