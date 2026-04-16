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
  automationUpdateInputSchema
} from "./schemas";
import type { RpcHandler } from "./types";
import { validateInput } from "./validation";

export function createAutomationHandlers(): Record<string, RpcHandler> {
  return {
    [AUTOMATION_IPC_CHANNELS.LIST_JOBS]: async () => listAutomationJobs(),
    [AUTOMATION_IPC_CHANNELS.CREATE_JOB]: async (params) => {
      await startAutomationRunner();
      const created = createAutomationJob(
        validateInput(
          automationCreateInputSchema,
          params,
          AUTOMATION_IPC_CHANNELS.CREATE_JOB
        ) as AutomationCreateJobInput
      );
      await refreshAutomationRunnerJobs();
      return created;
    },
    [AUTOMATION_IPC_CHANNELS.UPDATE_JOB]: async (params) => {
      await startAutomationRunner();
      const updated = updateAutomationJob(
        validateInput(
          automationUpdateInputSchema,
          params,
          AUTOMATION_IPC_CHANNELS.UPDATE_JOB
        ) as AutomationUpdateJobInput
      );
      await refreshAutomationRunnerJobs();
      return updated;
    },
    [AUTOMATION_IPC_CHANNELS.DELETE_JOB]: async (params) => {
      await startAutomationRunner();
      const result = deleteAutomationJob(
        validateInput(
          automationDeleteInputSchema,
          params,
          AUTOMATION_IPC_CHANNELS.DELETE_JOB
        ) as AutomationDeleteJobInput
      );
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
    }
  };
}
