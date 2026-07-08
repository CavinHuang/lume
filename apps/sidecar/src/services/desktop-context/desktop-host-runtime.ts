import { connectDesktopHost, DesktopHostRpcClient } from "./desktop-host-client";

interface DesktopHostCallable {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
}

interface DesktopHostEnvironment {
  LUME_DESKTOP_HOST_ENDPOINT?: string;
  LUME_DESKTOP_HOST_TOKEN?: string;
}

export function createDesktopHostInvoker(input: {
  env?: DesktopHostEnvironment;
  createClient?: (options: { endpoint: string; token: string }) => DesktopHostCallable;
} = {}) {
  const env = input.env ?? process.env;
  const endpoint = env.LUME_DESKTOP_HOST_ENDPOINT?.trim();
  const token = env.LUME_DESKTOP_HOST_TOKEN?.trim();
  let client: DesktopHostCallable | null = null;

  return async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (!endpoint || !token) {
      if (method === "diagnose_permissions") {
        return unavailablePermissionDiagnostics("Lume desktop host is not configured");
      }
      return { status: "unavailable", message: "Lume desktop host is not configured" };
    }
    try {
      client ??= input.createClient
        ? input.createClient({ endpoint, token })
        : new DesktopHostRpcClient({ token, connect: () => connectDesktopHost(endpoint) });
      return await client.call(method, params);
    } catch (error) {
      const message = `desktop host connection failed: ${error instanceof Error ? error.message : String(error)}`;
      if (method === "diagnose_permissions") {
        return unavailablePermissionDiagnostics(message);
      }
      return {
        status: "unavailable",
        message,
      };
    }
  };
}

export const invokeDesktopHost = createDesktopHostInvoker();

function unavailablePermissionDiagnostics(message: string): Record<string, unknown> {
  return {
    status: "unavailable",
    platform: process.platform,
    message,
    permissionTarget: {
      appName: "Lume Computer Use",
      appBundleName: "Lume Computer Use.app",
      bundleId: "com.lume.computer-use",
      authorizationSubject: "appBundle",
    },
    permissions: [
      {
        id: "accessibility",
        title: "Accessibility",
        status: "unknown",
        settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      },
      {
        id: "screenRecording",
        title: "Screen & System Audio Recording",
        status: "unknown",
        settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      },
    ],
  };
}
