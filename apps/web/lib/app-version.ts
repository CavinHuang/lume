interface AppVersionEnv {
  VITE_APP_VERSION?: string;
  NEXT_PUBLIC_APP_VERSION?: string;
}

export function resolveAppVersion(env: AppVersionEnv): string {
  const viteVersion = env.VITE_APP_VERSION?.trim();
  if (viteVersion) {
    return viteVersion;
  }

  const nextPublicVersion = env.NEXT_PUBLIC_APP_VERSION?.trim();
  if (nextPublicVersion) {
    return nextPublicVersion;
  }

  return "dev";
}

export function getAppVersion(): string {
  const env = (import.meta.env ?? {}) as AppVersionEnv;
  return resolveAppVersion(env);
}
