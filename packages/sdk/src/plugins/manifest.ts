export function validatePluginPath(value: string, field: string): void {
  if (!value.startsWith("./")) {
    throw new Error(`Invalid ${field}: path must start with "./"`);
  }
  const segments = value.slice(2).split("/");
  for (const segment of segments) {
    if (segment === "..") {
      throw new Error(`Invalid ${field}: path must not contain ".."`);
    }
  }
}

export function validatePluginName(name: string): void {
  if (!/^[a-z0-9_-]{1,64}$/.test(name)) {
    throw new Error(
      `Invalid plugin name: "${name}". Must be 1-64 ASCII chars: a-z, 0-9, _, -.`,
    );
  }
}

export function validateSemver(version: string): void {
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(
      `Invalid version: "${version}". Must be semver (e.g. "1.0.0").`,
    );
  }
}

export interface PluginPermissions {
  filesystem?: {
    read?: string[];
    write?: string[];
  };
  network?: {
    outbound?: string[];
  };
  mcpServers?: {
    register?: boolean;
  };
  shell?: {
    allow?: boolean;
  };
  tools?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
  };
  hooks?: {
    events?: string[];
  };
}

export type PluginMarketplaceSetupKind =
  | "install"
  | "enable"
  | "browser-auth"
  | "pairing-code"
  | "local-service"
  | "mcp"
  | "custom";

export type PluginSetupArtifactKind =
  | "chrome-extension"
  | "obsidian-plugin"
  | "native-binary"
  | "node-bundle"
  | "file";

export interface PluginSetupArtifact {
  path: string;
  kind: PluginSetupArtifactKind;
}

export interface PluginSetupDownload {
  url: string;
  filename?: string;
  sha256?: string;
}

export interface PluginSetupBuild {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  prerequisites?: string;
}

export interface PluginSetupTargetApp {
  kind: "chrome" | "obsidian" | "system-path";
  installHint?: string;
}

export interface PluginSetupVerify {
  method: "tcp-port" | "chrome-extension" | "http-get" | "none";
  detail?: string;
}

export interface PluginMarketplaceSetupStep {
  id: string;
  title: string;
  description: string;
  kind?: PluginMarketplaceSetupKind;
  artifact?: PluginSetupArtifact;
  download?: PluginSetupDownload;
  build?: PluginSetupBuild;
  targetApp?: PluginSetupTargetApp;
  verify?: PluginSetupVerify;
}

export interface PluginMarketplaceManifest {
  icon?: string;
  thumbnail?: string;
  hero?: string;
  website?: string;
  docs?: string;
  setup?: PluginMarketplaceSetupStep[];
}

export interface LumePluginManifest {
  schema: "lume-plugin/v1";
  name: string;
  version: string;
  description?: string;
  author?: string;
  displayName?: string;
  category?: string;
  skills?: string[];
  hooks?: string;
  mcpServers?: string;
  commandTools?: Array<Record<string, unknown>>;
  permissions?: PluginPermissions;
  marketplace?: PluginMarketplaceManifest;
  lume?: {
    hooksOnly?: boolean;
    exclusivePermissions?: boolean;
  };
}

const DEFAULT_PERMISSIONS: PluginPermissions = {
  filesystem: { read: ["./**"], write: ["./data/**"] },
  network: { outbound: [] },
  mcpServers: { register: false },
  shell: { allow: false },
};

const MARKETPLACE_SETUP_KINDS = new Set<PluginMarketplaceSetupKind>([
  "install",
  "enable",
  "browser-auth",
  "pairing-code",
  "local-service",
  "mcp",
  "custom",
]);

export function parseManifest(raw: Record<string, unknown>): LumePluginManifest {
  if (raw.schema !== "lume-plugin/v1") {
    throw new Error(
      `Unsupported schema: "${raw.schema}". Expected "lume-plugin/v1".`,
    );
  }

  const name = raw.name as string;
  validatePluginName(name);

  const version = raw.version as string;
  validateSemver(version);

  if (typeof raw.skills === "string") {
    validatePluginPath(raw.skills, "skills");
  } else if (Array.isArray(raw.skills)) {
    for (const path of raw.skills) {
      validatePluginPath(path as string, "skills");
    }
  }

  if (typeof raw.hooks === "string") {
    validatePluginPath(raw.hooks, "hooks");
  }
  if (typeof raw.mcpServers === "string") {
    validatePluginPath(raw.mcpServers, "mcpServers");
  }

  const marketplace = normalizeMarketplace(raw.marketplace);

  const result: LumePluginManifest = {
    schema: "lume-plugin/v1",
    name,
    version,
    description: raw.description as string | undefined,
    author: raw.author as string | undefined,
    displayName: raw.displayName as string | undefined,
    category: raw.category as string | undefined,
    skills: Array.isArray(raw.skills)
      ? raw.skills.map((s) => s as string)
      : raw.skills
        ? [raw.skills as string]
        : undefined,
    hooks: raw.hooks as string | undefined,
    mcpServers: raw.mcpServers as string | undefined,
    commandTools: Array.isArray(raw.commandTools)
      ? raw.commandTools.filter(
          (tool): tool is Record<string, unknown> =>
            Boolean(tool) && typeof tool === "object" && !Array.isArray(tool),
        )
      : undefined,
    marketplace,
  };

  if (raw.permissions && typeof raw.permissions === "object") {
    result.permissions = raw.permissions as PluginPermissions;
  }

  if (raw.lume && typeof raw.lume === "object") {
    const lumeRaw = raw.lume as Record<string, unknown>;
    result.lume = {
      hooksOnly: lumeRaw.hooksOnly as boolean | undefined,
      exclusivePermissions: lumeRaw.exclusivePermissions as boolean | undefined,
    };
  }

  return result;
}

function normalizeMarketplace(raw: unknown): PluginMarketplaceManifest | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const result: PluginMarketplaceManifest = {};

  for (const field of ["icon", "thumbnail", "hero", "docs"] as const) {
    const path = value[field];
    if (typeof path !== "string") continue;
    validatePluginPath(path, `marketplace.${field}`);
    result[field] = path;
  }

  if (typeof value.website === "string") {
    result.website = value.website;
  }

  if (Array.isArray(value.setup)) {
    const setup = value.setup.flatMap((entry): PluginMarketplaceSetupStep[] => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const step = entry as Record<string, unknown>;
      if (
        typeof step.id !== "string"
        || typeof step.title !== "string"
        || typeof step.description !== "string"
      ) {
        return [];
      }
      const artifact = parseArtifact(step.artifact);
      const download = parseDownload(step.download);
      const build = parseBuild(step.build);
      const targetApp = parseTargetApp(step.targetApp);
      const verify = parseVerify(step.verify);
      // artifact.path 非法时整步丢弃（与现有 validatePluginPath 抛错语义一致）
      if (step.artifact && !artifact) return [];
      return [{
        id: step.id,
        title: step.title,
        description: step.description,
        ...(typeof step.kind === "string" && MARKETPLACE_SETUP_KINDS.has(step.kind as PluginMarketplaceSetupKind)
          ? { kind: step.kind as PluginMarketplaceSetupKind }
          : {}),
        ...(artifact ? { artifact } : {}),
        ...(download ? { download } : {}),
        ...(build ? { build } : {}),
        ...(targetApp ? { targetApp } : {}),
        ...(verify ? { verify } : {}),
      }];
    });
    if (setup.length > 0) {
      result.setup = setup;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

const SETUP_ARTIFACT_KINDS = new Set<PluginSetupArtifactKind>([
  "chrome-extension", "obsidian-plugin", "native-binary", "node-bundle", "file",
]);
const SETUP_TARGET_KINDS = new Set<PluginSetupTargetApp["kind"]>(["chrome", "obsidian", "system-path"]);
const SETUP_VERIFY_METHODS = new Set<PluginSetupVerify["method"]>(["tcp-port", "chrome-extension", "http-get", "none"]);

function parseArtifact(raw: unknown): PluginSetupArtifact | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  if (typeof v.path !== "string" || typeof v.kind !== "string") return undefined;
  if (!SETUP_ARTIFACT_KINDS.has(v.kind as PluginSetupArtifactKind)) return undefined;
  try {
    validatePluginPath(v.path, "marketplace.setup.artifact.path");
  } catch {
    return undefined;
  }
  return { path: v.path, kind: v.kind as PluginSetupArtifactKind };
}

function parseDownload(raw: unknown): PluginSetupDownload | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  if (typeof v.url !== "string") return undefined;
  // 强制 https
  if (!v.url.startsWith("https://")) return undefined;
  return {
    url: v.url,
    ...(typeof v.filename === "string" ? { filename: v.filename } : {}),
    ...(typeof v.sha256 === "string" ? { sha256: v.sha256 } : {}),
  };
}

function parseBuild(raw: unknown): PluginSetupBuild | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  if (typeof v.command !== "string") return undefined;
  if (typeof v.cwd === "string") {
    try { validatePluginPath(v.cwd, "marketplace.setup.build.cwd"); }
    catch { return undefined; }
  }
  return {
    command: v.command,
    ...(typeof v.cwd === "string" ? { cwd: v.cwd } : {}),
    ...(v.env && typeof v.env === "object" && !Array.isArray(v.env) ? { env: v.env as Record<string, string> } : {}),
    ...(typeof v.prerequisites === "string" ? { prerequisites: v.prerequisites } : {}),
  };
}

function parseTargetApp(raw: unknown): PluginSetupTargetApp | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  if (typeof v.kind !== "string" || !SETUP_TARGET_KINDS.has(v.kind as PluginSetupTargetApp["kind"])) return undefined;
  return {
    kind: v.kind as PluginSetupTargetApp["kind"],
    ...(typeof v.installHint === "string" ? { installHint: v.installHint } : {}),
  };
}

function parseVerify(raw: unknown): PluginSetupVerify | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  if (typeof v.method !== "string" || !SETUP_VERIFY_METHODS.has(v.method as PluginSetupVerify["method"])) return undefined;
  return {
    method: v.method as PluginSetupVerify["method"],
    ...(typeof v.detail === "string" ? { detail: v.detail } : {}),
  };
}

export function inferDefaults(manifest: LumePluginManifest): LumePluginManifest {
  return {
    ...manifest,
    permissions: { ...DEFAULT_PERMISSIONS, ...manifest.permissions },
    lume: {
      hooksOnly: false,
      exclusivePermissions: false,
      ...manifest.lume,
    },
  };
}

export function validateManifest(raw: Record<string, unknown>): LumePluginManifest {
  const parsed = parseManifest(raw);
  return inferDefaults(parsed);
}
