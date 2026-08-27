import { idSchema, z } from "../validation";
import { agentThreadIdInputSchema } from "./shared";

export const resumeRunInputSchema = z.object({
  threadId: idSchema,
  runId: idSchema.optional(),
  interruptionId: idSchema.optional(),
});

export const discardInterruptedRunInputSchema = z.object({
  threadId: idSchema,
  runId: idSchema.optional(),
});

export const listRunStatesInputSchema = z.object({
  threadId: idSchema,
});

export const getPendingResumeInputSchema = z.object({
  threadId: idSchema,
});

export const getEventsInputSchema = z.object({
  threadId: idSchema,
  afterSeq: z.number().int().nonnegative().optional(),
});

export const runTraceInputSchema = z.object({
  threadId: idSchema,
  runId: idSchema.optional(),
  traceId: idSchema.optional(),
  redactionLevel: z.enum(["safe_summary", "diagnostic"]).optional(),
});
