import type { LumeToolDescriptor } from "../tools/tool-types";
import {
  GRANT_PREFIX_SCOPE_MARK,
  GRANT_TOOL_SCOPE_MARK,
  allowsCommandScopeGrant,
  buildPermissionFingerprint,
  matchEncodedGrants
} from "./permission-rules";
import type { AgentToolPermissionAllowScope } from "@lume/shared";
import { toolGrantId, toolGrantMirror } from "./persisted-grant-store";

export interface PermissionSessionGrantInput {
  threadId: string;
  descriptor: LumeToolDescriptor;
  input: unknown;
  /** 携带时授权跨线程生效（workspace 持久集兜底，#775） */
  workspaceSlug?: string;
}

/** allow_always 附带的持久化定位信息；无 workspaceSlug 的运行保持纯内存（行为同前） */
export interface GrantOrigin {
  workspaceSlug?: string;
  toolName?: string;
}

export interface PermissionSessionStore {
  grant(input: PermissionSessionGrantInput): void;
  grantFingerprint(threadId: string, fingerprint: string): void;
  /**
   * 按「始终允许」作用域档位写入宽指纹（#558），返回实际生效档（宽档被否决时降级 exact）。
   * 携带 origin.workspaceSlug 时同步镜像到 workspace 持久集并落盘（#775）。
   */
  grantFingerprintWithScope(
    threadId: string,
    fingerprint: string,
    scope: AgentToolPermissionAllowScope,
    origin?: GrantOrigin
  ): AgentToolPermissionAllowScope;
  bypass(threadId: string): void;
  isGranted(input: PermissionSessionGrantInput): boolean;
  isFingerprintGranted(threadId: string, fingerprint: string): boolean;
  isBypassed(threadId: string): boolean;
  clear(threadId: string): void;
}

function splitFingerprint(fingerprint: string): { name: string; key: string } | null {
  const idx = fingerprint.indexOf(":");
  if (idx <= 0) return null;
  return { name: fingerprint.slice(0, idx), key: fingerprint.slice(idx + 1) };
}

function commandScopeFingerprint(fingerprint: string): string | null {
  const parts = splitFingerprint(fingerprint);
  if (!parts) return null;
  const command = parts.key.trim();
  if (!command) return null;
  // review P1:shell 连接符后缀(`&&`/`||`/`;`)会以空白开头命中词边界,
  // bash 类指纹必须 simple/只读才给前缀档,否则调用方降级 exact
  if (!allowsCommandScopeGrant(parts.name, parts.key)) return null;
  return `${GRANT_PREFIX_SCOPE_MARK}${parts.name}:${command}`;
}

function toolScopeFingerprint(fingerprint: string): string | null {
  const parts = splitFingerprint(fingerprint);
  if (!parts || !parts.name) return null;
  return `${GRANT_TOOL_SCOPE_MARK}${parts.name}`;
}

export function createPermissionSessionStore(): PermissionSessionStore {
  const grantsByThread = new Map<string, Set<string>>();
  const bypassedThreads = new Set<string>();
  const grantsFor = (threadId: string): Set<string> => {
    let grants = grantsByThread.get(threadId);
    if (!grants) {
      grants = new Set();
      grantsByThread.set(threadId, grants);
    }
    return grants;
  };
  const grantFingerprint = (threadId: string, fingerprint: string): void => {
    const normalized = fingerprint.trim();
    if (!normalized) return;
    grantsFor(threadId).add(normalized);
  };
  const grantFingerprintWithScope = (
    threadId: string,
    fingerprint: string,
    scope: AgentToolPermissionAllowScope,
    origin?: GrantOrigin
  ): AgentToolPermissionAllowScope => {
    grantFingerprint(threadId, fingerprint);
    // 三轮 review(UI F6):返回实际生效档——宽档被否决时静默降级 exact,
    // 上游据此生成如实的 toast 回执,不再宣称未生效的作用域
    let effectiveScope: AgentToolPermissionAllowScope = "exact";
    let encoded: string | null = null;
    if (scope === "tool") {
      encoded = toolScopeFingerprint(fingerprint.trim());
      effectiveScope = encoded ? "tool" : "exact";
    } else if (scope === "command") {
      encoded = commandScopeFingerprint(fingerprint.trim());
      effectiveScope = encoded ? "command" : "exact";
    }
    if (encoded) grantsFor(threadId).add(encoded);

    // #775:workspace 级持久镜像——同一次授权的编码集原样跨线程、跨重启生效
    const workspaceSlug = origin?.workspaceSlug?.trim();
    if (workspaceSlug) {
      const fingerprints = [fingerprint.trim(), ...(encoded ? [encoded] : [])];
      toolGrantMirror.upsert({
        id: toolGrantId(workspaceSlug, fingerprints),
        workspaceSlug,
        scope: effectiveScope,
        toolName: origin?.toolName ?? splitFingerprint(fingerprint.trim())?.name ?? "",
        fingerprints,
        createdAt: new Date().toISOString(),
      });
    }
    return effectiveScope;
  };
  const isFingerprintGranted = (threadId: string, fingerprint: string): boolean => {
    const normalized = fingerprint.trim();
    if (!normalized) return false;
    const grants = grantsByThread.get(threadId);
    if (!grants) return false;
    return matchEncodedGrants(grants, normalized);
  };

  return {
    grant(input) {
      const fingerprint = buildPermissionFingerprint({
        descriptor: input.descriptor,
        rawInput: input.input
      });
      grantFingerprint(input.threadId, fingerprint);
    },
    grantFingerprint,
    grantFingerprintWithScope,
    bypass(threadId) {
      const normalized = threadId.trim();
      if (!normalized) return;
      bypassedThreads.add(normalized);
    },
    isGranted(input) {
      const fingerprint = buildPermissionFingerprint({
        descriptor: input.descriptor,
        rawInput: input.input
      });
      // 线程内集合优先；未命中且带 workspace 时查持久集（#775 跨线程语义）
      if (isFingerprintGranted(input.threadId, fingerprint)) return true;
      return toolGrantMirror.match(input.workspaceSlug, fingerprint);
    },
    isFingerprintGranted,
    isBypassed(threadId) {
      const normalized = threadId.trim();
      if (!normalized) return false;
      return bypassedThreads.has(normalized);
    },
    clear(threadId) {
      grantsByThread.delete(threadId);
      bypassedThreads.delete(threadId);
    }
  };
}

export const runtimePermissionSessionStore = createPermissionSessionStore();
