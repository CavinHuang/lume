import { z } from "zod";

export { z };

export const idSchema = z.string().min(1);
export const optionalIdSchema = z.string().min(1).optional();

export function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function validateInput<T>(schema: z.ZodType<T>, payload: unknown, method: string): T {
  const parsed = schema.safeParse(payload);
  if (parsed.success) {
    return parsed.data;
  }
  const firstIssue = parsed.error.issues[0];
  const path = firstIssue?.path.join(".") || "root";
  const message = firstIssue?.message || "参数校验失败";
  throw new Error(`${method} 参数非法: ${path} - ${message}`);
}
