import { isAbsolute, relative, resolve } from "node:path";
import { canonicalizeAgentToolName } from "@lume/shared";
import { evaluateRuntimeToolSafety } from "./runtime-tool-safety";
import type { LumeGuardrail } from "./guardrail-types";
import type { RunToolInputGuardrailsInput } from "./guardrail-runner";

export const runtimeToolSafetyGuardrail: LumeGuardrail<RunToolInputGuardrailsInput> = {
  id: "builtin.runtime-tool-safety",
  name: "Runtime tool safety",
  scope: "tool_input",
  mode: "blocking",
  async run(input, context) {
    const decision = evaluateRuntimeToolSafety(input.toolName, input.input);
    if (decision.behavior === "deny") {
      return {
        behavior: "reject",
        reason: decision.reason
      };
    }
    if (decision.behavior === "confirm") {
      return {
        behavior: "require_approval",
        reason: decision.reason
      };
    }
    return { behavior: "allow" };
  }
};

export const fileWriteBoundaryGuardrail: LumeGuardrail<RunToolInputGuardrailsInput> = {
  id: "builtin.file-write-boundary",
  name: "File write boundary",
  scope: "tool_input",
  mode: "blocking",
  async run(input, context) {
    const normalized = canonicalizeAgentToolName(input.toolName);
    if (!["write", "edit", "multiedit", "notebookedit"].includes(normalized)) {
      return { behavior: "allow" };
    }
    const cwd = input.context.cwd;
    if (!cwd) return { behavior: "allow" };
    const roots = [cwd, ...(context.additionalDirectories ?? input.context.additionalDirectories ?? [])]
      .map((root) => resolve(root));
    const paths = collectFileWritePaths(input.input);
    for (const path of paths) {
      const absolutePath = resolve(cwd, path);
      if (!roots.some((root) => isInsideDirectory(root, absolutePath))) {
        return {
          behavior: "reject",
          reason: "禁止写入 workspace 外路径"
        };
      }
    }
    return { behavior: "allow" };
  }
};

export const sensitiveMemoryWriteGuardrail: LumeGuardrail<RunToolInputGuardrailsInput> = {
  id: "builtin.sensitive-memory-write",
  name: "Sensitive memory write",
  scope: "tool_input",
  mode: "blocking",
  async run(input) {
    const normalized = canonicalizeAgentToolName(input.toolName);
    if (!normalized.startsWith("memory.") && !normalized.startsWith("memory_")) {
      return { behavior: "allow" };
    }
    if (!isMemoryWriteTool(normalized)) {
      return { behavior: "allow" };
    }
    if (!containsSecretLikeValue(input.input)) {
      return { behavior: "allow" };
    }
    return {
      behavior: "require_approval",
      reason: "记忆写入疑似包含密钥或 token，需要用户确认"
    };
  }
};

export const builtinToolInputGuardrails = [
  runtimeToolSafetyGuardrail,
  fileWriteBoundaryGuardrail,
  sensitiveMemoryWriteGuardrail
];

function collectFileWritePaths(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  const direct = [record.file_path, record.filePath, record.path, record.notebook_path]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const edits = Array.isArray(record.edits)
    ? record.edits.flatMap((edit) => collectFileWritePaths(edit))
    : [];
  return [...direct, ...edits];
}

function isInsideDirectory(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isMemoryWriteTool(normalizedToolName: string): boolean {
  return normalizedToolName.includes("remember")
    || normalizedToolName.includes("save")
    || normalizedToolName.includes("write")
    || normalizedToolName.includes("flush")
    || normalizedToolName.includes("distill")
    || normalizedToolName.includes("promote");
}

function containsSecretLikeValue(value: unknown): boolean {
  if (typeof value === "string") {
    return /(?:api[_-]?key|token|secret|private[_-]?key|password)\s*[=:]/i.test(value)
      || /\bsk-[a-zA-Z0-9_-]{8,}\b/.test(value)
      || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value);
  }
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsSecretLikeValue);
  return Object.entries(value).some(([key, entry]) => (
    /(?:api[_-]?key|token|secret|private[_-]?key|password)/i.test(key)
    || containsSecretLikeValue(entry)
  ));
}
