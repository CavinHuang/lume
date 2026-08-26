import type { LumeToolDescriptor } from "../tools/tool-types";
import { COMMAND_CONNECTOR_PATTERN, allowsCommandScopeGrant, buildPermissionFingerprint } from "./permission-rules";
import type { AgentToolPermissionAllowScope } from "@lume/shared";

export interface PermissionSessionGrantInput {
  threadId: string;
  descriptor: LumeToolDescriptor;
  input: unknown;
}

export interface PermissionSessionStore {
  grant(input: PermissionSessionGrantInput): void;
  grantFingerprint(threadId: string, fingerprint: string): void;
  /** 按「始终允许」作用域档位写入宽指纹（#558）。 */
  grantFingerprintWithScope(threadId: string, fingerprint: string, scope: AgentToolPermissionAllowScope): void;
  bypass(threadId: string): void;
  isGranted(input: PermissionSessionGrantInput): boolean;
  isFingerprintGranted(threadId: string, fingerprint: string): boolean;
  isBypassed(threadId: string): boolean;
  clear(threadId: string): void;
}

/**
 * 宽指纹编码：exact 档存原串；command/tool 档加前缀标记后与 exact 共存于同一
 * 集合。`>` = 同命令前缀（请求指纹以已授 key 开头且落在词边界），`*` = 同工具。
 * ponytail: 单 Set 编码复用既有存储，撤销/查看入口出现前不引入第二数据结构。
 */
const PREFIX_SCOPE_MARK = ">";
const TOOL_SCOPE_MARK = "*";

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
  return `${PREFIX_SCOPE_MARK}${parts.name}:${command}`;
}

function toolScopeFingerprint(fingerprint: string): string | null {
  const parts = splitFingerprint(fingerprint);
  if (!parts || !parts.name) return null;
  return `${TOOL_SCOPE_MARK}${parts.name}`;
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
    scope: AgentToolPermissionAllowScope
  ): void => {
    grantFingerprint(threadId, fingerprint);
    if (scope === "tool") {
      const encoded = toolScopeFingerprint(fingerprint.trim());
      if (encoded) grantsFor(threadId).add(encoded);
      return;
    }
    if (scope === "command") {
      const encoded = commandScopeFingerprint(fingerprint.trim());
      if (encoded) grantsFor(threadId).add(encoded);
    }
  };
  const isFingerprintGranted = (threadId: string, fingerprint: string): boolean => {
    const normalized = fingerprint.trim();
    if (!normalized) return false;
    const grants = grantsByThread.get(threadId);
    if (!grants) return false;
    if (grants.has(normalized)) return true;
    for (const grant of grants) {
      // 同工具档：工具名一致即放行
      if (grant.startsWith(TOOL_SCOPE_MARK) && normalized.startsWith(grant.slice(1) + ":")) {
        return true;
      }
      // 同命令前缀档：key 以已授命令开头且止于词边界（不放行 `ls` → `lsblk`）。
      // 二轮 review P1:匹配侧必须与建档侧同一否决口径——rest 含连接符/管道/
      // 重定向/命令替换时不得放行,否则 `npm test` 授档后
      // `npm test && curl … | sh` 以空白开头照样命中。
      if (grant.startsWith(PREFIX_SCOPE_MARK)) {
        const grantedKey = grant.slice(PREFIX_SCOPE_MARK.length);
        const rest = normalized.slice(grantedKey.length);
        if (
          normalized.startsWith(grantedKey)
          && (rest === ""
            || (/^\s/.test(rest) && !COMMAND_CONNECTOR_PATTERN.test(rest)))
        ) {
          return true;
        }
      }
    }
    return false;
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
      return isFingerprintGranted(input.threadId, buildPermissionFingerprint({
        descriptor: input.descriptor,
        rawInput: input.input
      }));
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
