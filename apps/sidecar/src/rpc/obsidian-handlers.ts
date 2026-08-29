/**
 * Obsidian Vault RPC handlers（sidecar）。
 *
 * 模式与 suggestion-handlers / model-meta-handlers 一致：每个 channel 用
 * `validateInput` 校验入参，失败 throw（→ reject → toast）。vaultPath 每次调用
 * 都经 resolveAuthorizedVaultRoot 对照当前候选集校验——根路径从不信任渲染层。
 */

import {
  OBSIDIAN_VAULT_IPC_CHANNELS,
  type ObsidianVaultConfig,
  type ObsidianVaultFocus,
  type ObsidianVaultReadResult,
} from "@lume/shared";
import { getEffectiveLumeConfig, updateLumeConfigSection } from "../services/system/lume-config-service";
import {
  getObsidianVaultConfig,
  resolveAuthorizedVaultRoot,
  createManagedVault,
} from "../services/obsidian/vault-registry";
import { createVaultFileSystem } from "../services/obsidian/vault-facade";
import { clearObsidianVaultFocus, setObsidianVaultFocus } from "../services/obsidian/vault-focus";
import type { RpcHandler } from "./types";
import { validateInput, z } from "./validation";

const vaultPathSchema = z.object({ vaultPath: z.string().trim().min(1) }).strict();

const relativePathSchema = vaultPathSchema.extend({ relativePath: z.string().min(1) });

const writeFileInputSchema = relativePathSchema.extend({
  content: z.string(),
  expectedSha256: z.string().optional(),
});

const createNoteInputSchema = vaultPathSchema.extend({
  folderPath: z.string().optional(),
});

const renameFileInputSchema = relativePathSchema.extend({
  name: z.string().trim().min(1),
  expectedSha256: z.string().optional(),
});

const deleteFileInputSchema = relativePathSchema.extend({
  expectedSha256: z.string().optional(),
});

const setFocusInputSchema = z
  .object({
    threadId: z.string().trim().min(1),
    vaultPath: z.string().trim().min(1),
    focus: z
      .object({
        kind: z.enum(["file", "folder"]),
        relativePath: z.string(),
        sequence: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict();

function withVaultFileSystem<T>(vaultPath: string, run: (fs: ReturnType<typeof createVaultFileSystem>) => T): T {
  const root = resolveAuthorizedVaultRoot(vaultPath);
  return run(createVaultFileSystem(root));
}

function updateExtraVaults(mutate: (current: string[]) => string[]): void {
  const current = getEffectiveLumeConfig().obsidian?.extraVaults ?? [];
  updateLumeConfigSection({
    source: "user",
    path: "obsidian.extraVaults",
    value: mutate(current),
    summary: "obsidian extraVaults updated",
  });
}

export function createObsidianVaultHandlers(): Record<string, RpcHandler> {
  return {
    [OBSIDIAN_VAULT_IPC_CHANNELS.GET_CONFIG]: async () => {
      return getObsidianVaultConfig() satisfies ObsidianVaultConfig;
    },
    [OBSIDIAN_VAULT_IPC_CHANNELS.SET_ENABLED]: async (params) => {
      const input = validateInput(z.object({ enabled: z.boolean() }).strict(), params, OBSIDIAN_VAULT_IPC_CHANNELS.SET_ENABLED);
      updateLumeConfigSection({ source: "user", path: "obsidian.enabled", value: input.enabled, summary: "obsidian enabled toggled" });
      return { ok: true as const };
    },
    [OBSIDIAN_VAULT_IPC_CHANNELS.ADD_FOLDER_VAULT]: async (params) => {
      const input = validateInput(vaultPathSchema, params, OBSIDIAN_VAULT_IPC_CHANNELS.ADD_FOLDER_VAULT);
      // 先校验是真实存在的目录，再落盘。
      resolveAuthorizedVaultRoot(input.vaultPath);
      updateExtraVaults((current) => (current.includes(input.vaultPath) ? current : [...current, input.vaultPath]));
      return getObsidianVaultConfig() satisfies ObsidianVaultConfig;
    },
    [OBSIDIAN_VAULT_IPC_CHANNELS.REMOVE_FOLDER_VAULT]: async (params) => {
      const input = validateInput(vaultPathSchema, params, OBSIDIAN_VAULT_IPC_CHANNELS.REMOVE_FOLDER_VAULT);
      updateExtraVaults((current) => current.filter((path) => path !== input.vaultPath));
      return { ok: true as const };
    },
    [OBSIDIAN_VAULT_IPC_CHANNELS.CREATE_MANAGED_VAULT]: async () => {
      createManagedVault();
      return getObsidianVaultConfig() satisfies ObsidianVaultConfig;
    },
    [OBSIDIAN_VAULT_IPC_CHANNELS.LIST_FILES]: async (params) => {
      const input = validateInput(vaultPathSchema, params, OBSIDIAN_VAULT_IPC_CHANNELS.LIST_FILES);
      return withVaultFileSystem(input.vaultPath, (fs) => fs.listFiles());
    },
    [OBSIDIAN_VAULT_IPC_CHANNELS.READ_FILE]: async (params) => {
      const input = validateInput(relativePathSchema, params, OBSIDIAN_VAULT_IPC_CHANNELS.READ_FILE);
      return withVaultFileSystem(input.vaultPath, (fs) => fs.readFile(input.relativePath)) satisfies ObsidianVaultReadResult;
    },
    [OBSIDIAN_VAULT_IPC_CHANNELS.WRITE_FILE]: async (params) => {
      const input = validateInput(writeFileInputSchema, params, OBSIDIAN_VAULT_IPC_CHANNELS.WRITE_FILE);
      return withVaultFileSystem(input.vaultPath, (fs) =>
        fs.writeFile({ relativePath: input.relativePath, content: input.content, expectedSha256: input.expectedSha256 }),
      );
    },
    [OBSIDIAN_VAULT_IPC_CHANNELS.CREATE_NOTE]: async (params) => {
      const input = validateInput(createNoteInputSchema, params, OBSIDIAN_VAULT_IPC_CHANNELS.CREATE_NOTE);
      return withVaultFileSystem(input.vaultPath, (fs) => fs.createUntitledNote(input.folderPath ?? ""));
    },
    [OBSIDIAN_VAULT_IPC_CHANNELS.CREATE_FOLDER]: async (params) => {
      const input = validateInput(relativePathSchema, params, OBSIDIAN_VAULT_IPC_CHANNELS.CREATE_FOLDER);
      withVaultFileSystem(input.vaultPath, (fs) => fs.createFolder(input.relativePath));
      return { ok: true as const };
    },
    [OBSIDIAN_VAULT_IPC_CHANNELS.RENAME_FILE]: async (params) => {
      const input = validateInput(renameFileInputSchema, params, OBSIDIAN_VAULT_IPC_CHANNELS.RENAME_FILE);
      return withVaultFileSystem(input.vaultPath, (fs) =>
        fs.renameFile({ relativePath: input.relativePath, name: input.name, expectedSha256: input.expectedSha256 }),
      ) satisfies ObsidianVaultReadResult;
    },
    [OBSIDIAN_VAULT_IPC_CHANNELS.DELETE_FILE]: async (params) => {
      const input = validateInput(deleteFileInputSchema, params, OBSIDIAN_VAULT_IPC_CHANNELS.DELETE_FILE);
      withVaultFileSystem(input.vaultPath, (fs) => fs.deleteFile({ relativePath: input.relativePath, expectedSha256: input.expectedSha256 }));
      return { ok: true as const };
    },
    [OBSIDIAN_VAULT_IPC_CHANNELS.SET_FOCUS]: async (params) => {
      const input = validateInput(setFocusInputSchema, params, OBSIDIAN_VAULT_IPC_CHANNELS.SET_FOCUS);
      if (input.focus) {
        setObsidianVaultFocus(input.threadId, input.vaultPath, input.focus satisfies ObsidianVaultFocus);
      } else {
        clearObsidianVaultFocus(input.threadId);
      }
      return { ok: true as const };
    },
  };
}
