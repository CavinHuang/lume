export interface LumeRunError {
  code: string;
  message: string;
  stack?: string;
  retryable?: boolean;
}

export function normalizeLumeRunError(error: unknown, fallback = "runtime errored"): LumeRunError {
  if (error instanceof Error) {
    return {
      code: "runtime_error",
      message: error.message || fallback,
      stack: error.stack
    };
  }
  return {
    code: "runtime_error",
    message: typeof error === "string" && error.trim() ? error : fallback
  };
}
