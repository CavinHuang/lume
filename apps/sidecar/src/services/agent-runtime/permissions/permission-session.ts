import type { LumeToolDescriptor } from "../tools/tool-types";
import { buildPermissionFingerprint } from "./permission-rules";

export interface PermissionSessionGrantInput {
  threadId: string;
  descriptor: LumeToolDescriptor;
  input: unknown;
}

export interface PermissionSessionStore {
  grant(input: PermissionSessionGrantInput): void;
  grantFingerprint(threadId: string, fingerprint: string): void;
  isGranted(input: PermissionSessionGrantInput): boolean;
  isFingerprintGranted(threadId: string, fingerprint: string): boolean;
  clear(threadId: string): void;
}

export function createPermissionSessionStore(): PermissionSessionStore {
  const grantsByThread = new Map<string, Set<string>>();
  const grantFingerprint = (threadId: string, fingerprint: string): void => {
    const normalized = fingerprint.trim();
    if (!normalized) return;
    let grants = grantsByThread.get(threadId);
    if (!grants) {
      grants = new Set();
      grantsByThread.set(threadId, grants);
    }
    grants.add(normalized);
  };
  const isFingerprintGranted = (threadId: string, fingerprint: string): boolean => {
    const normalized = fingerprint.trim();
    if (!normalized) return false;
    const grants = grantsByThread.get(threadId);
    if (!grants) return false;
    return grants.has(normalized);
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
    isGranted(input) {
      return isFingerprintGranted(input.threadId, buildPermissionFingerprint({
        descriptor: input.descriptor,
        rawInput: input.input
      }));
    },
    isFingerprintGranted,
    clear(threadId) {
      grantsByThread.delete(threadId);
    }
  };
}

export const runtimePermissionSessionStore = createPermissionSessionStore();
