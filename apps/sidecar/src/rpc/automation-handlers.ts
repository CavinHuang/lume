import { AUTOMATION_IPC_CHANNELS } from "@lume/shared";
import type {
  AutomationCreateJobInput,
  AutomationDeleteJobInput,
  AutomationListRunsInput,
  AutomationRunNowInput,
  AutomationUpdateJobInput
} from "@lume/shared";
import {
  createAutomationJob,
  deleteAutomationJob,
  isSystemAutomationJob,
  listAutomationJobs,
  updateAutomationJob
} from "../services/automation/automation-manager";
import {
  listAutomationRuns,
  refreshAutomationRunnerJobs,
  startAutomationRunner,
  runAutomationJobNow
} from "../services/automation/automation-runner-service";
import {
  automationCreateInputSchema,
  automationDeleteInputSchema,
  automationListRunsInputSchema,
  automationRunNowInputSchema,
  automationToggleInputSchema,
  automationUpdateInputSchema
} from "./schemas";
import type { RpcHandler } from "./types";
import { validateInput } from "./validation";

export function createAutomationHandlers(): Record<string, RpcHandler> {
  return {
    [AUTOMATION_IPC_CHANNELS.LIST_JOBS]: async () => {
      // 外部修复 jobs.json 后调度自愈：刷新调度（runner 未启动时为 no-op）
      void refreshAutomationRunnerJobs().catch(() => undefined);
      return listAutomationJobs();
    },
    [AUTOMATION_IPC_CHANNELS.CREATE_JOB]: async (params) => {
      await startAutomationRunner();
      // #647 P2-23：RPC 创建强制 source:"manual"——无人值守 bypassPermissions 只
      // 授予 sidecar 内部调用方直写的任务，渲染进程不得经 RPC 铸造 system 通道
      const created = createAutomationJob({
        ...(validateInput(
          automationCreateInputSchema,
          params,
          AUTOMATION_IPC_CHANNELS.CREATE_JOB
        ) as AutomationCreateJobInput),
        source: "manual",
      });
      await refreshAutomationRunnerJobs();
      return created;
    },
    [AUTOMATION_IPC_CHANNELS.UPDATE_JOB]: async (params) => {
      await startAutomationRunner();
      const input = validateInput(
        automationUpdateInputSchema,
        params,
        AUTOMATION_IPC_CHANNELS.UPDATE_JOB
      ) as AutomationUpdateJobInput;
      // system 任务（routine 映射等）的 prompt/schedule 可被整体换血后按无人值守
      // bypass 周期执行，渲染进程不得改写（#647 P2-23 劫持面）
      const current = listAutomationJobs().find((job) => job.id === input.id);
      if (isSystemAutomationJob(current)) throw new Error("系统自动化任务不可在界面中修改");
      const updated = updateAutomationJob(input);
      await refreshAutomationRunnerJobs();
      return updated;
    },
    [AUTOMATION_IPC_CHANNELS.DELETE_JOB]: async (params) => {
      await startAutomationRunner();
      const input = validateInput(
        automationDeleteInputSchema,
        params,
        AUTOMATION_IPC_CHANNELS.DELETE_JOB
      ) as AutomationDeleteJobInput;
      // 同 UPDATE/TOGGLE：system 任务不可经渲染进程删除（#647 P2-23 劫持面）
      const current = listAutomationJobs().find((job) => job.id === input.id);
      if (isSystemAutomationJob(current)) throw new Error("系统自动化任务不可在界面中删除");
      const result = deleteAutomationJob(input);
      await refreshAutomationRunnerJobs();
      return result;
    },
    [AUTOMATION_IPC_CHANNELS.LIST_RUNS]: async (params) =>
      listAutomationRuns(
        validateInput(
          automationListRunsInputSchema,
          params ?? {},
          AUTOMATION_IPC_CHANNELS.LIST_RUNS
        ) as AutomationListRunsInput
      ),
    [AUTOMATION_IPC_CHANNELS.RUN_NOW]: async (params) => {
      await startAutomationRunner();
      return runAutomationJobNow(
        validateInput(
          automationRunNowInputSchema,
          params,
          AUTOMATION_IPC_CHANNELS.RUN_NOW
        ) as AutomationRunNowInput
      );
    },
    [AUTOMATION_IPC_CHANNELS.TOGGLE_JOB]: async (params) => {
      await startAutomationRunner();
      const input = validateInput(
        automationToggleInputSchema,
        params,
        AUTOMATION_IPC_CHANNELS.TOGGLE_JOB
      ) as { id: string };
      const jobs = listAutomationJobs();
      const target = jobs.find((j) => j.id === input.id);
      if (!target) {
        throw new Error(`自动化任务不存在: ${input.id}`);
      }
      // 同 UPDATE：system 任务不可经渲染进程启停（#647 P2-23 劫持面）
      if (isSystemAutomationJob(target)) {
        throw new Error("系统自动化任务不可在界面中启停");
      }
      const updated = updateAutomationJob({ id: target.id, enabled: !target.enabled });
      await refreshAutomationRunnerJobs();
      return updated;
    }
  };
}
