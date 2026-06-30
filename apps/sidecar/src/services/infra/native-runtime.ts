import {
  assertNativeAvailable,
  getNativeDiagnostics
} from "@lume/natives";

export interface SidecarNativeHealth {
  available: boolean;
  capabilities: string[];
  error?: string | null;
}

export function assertSidecarNativeRuntime(): SidecarNativeHealth {
  const diagnostics = assertNativeAvailable();
  return {
    available: true,
    capabilities: diagnostics.capabilities
  };
}

export function getSidecarNativeHealth(): SidecarNativeHealth {
  const diagnostics = getNativeDiagnostics();
  return {
    available: diagnostics.available,
    capabilities: diagnostics.capabilities,
    ...(diagnostics.error ? { error: diagnostics.error } : {})
  };
}
