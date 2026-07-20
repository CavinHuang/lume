import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { copyFile, cp, lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FinalizePluginPackageInput, PreparePluginPackageResult, RevokePluginPackageInput } from "@lume/shared";

const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CONCURRENT_PREPARATIONS = 3;
const MAX_RESERVED_TEMP_BYTES = 1024 * 1024 * 1024;
let activePreparations = 0;
let reservedTempBytes = 0;

interface PreparedPackageRecord {
  token: string;
  root: string;
  payloadPath: string;
  kind: "file" | "directory";
  suggestedFilename: string;
  size: number;
  sha256: string;
  verification: "verified" | "unverified";
  source: string;
  finalOrigin?: string;
  originChanged?: boolean;
  version?: string;
  ownerWebContentsId: number;
  ownerGeneration: number;
  expiresAt: number;
  state: "ready" | "consuming" | "consumed" | "revoked";
  reservedSize: number;
}

const preparedPackages = new Map<string, PreparedPackageRecord>();

export class PluginPackageError extends Error {
  constructor(
    public readonly code:
      | "package_not_found"
      | "package_expired"
      | "package_owner_mismatch"
      | "package_already_consumed"
      | "unsafe_package"
      | "download_failed"
      | "verify_failed"
      | "target_exists"
      | "resource_busy"
      | "quota_exceeded",
    message: string,
  ) {
    super(message);
    this.name = "PluginPackageError";
  }
}

export class PluginPackageService {
  private initialization: Promise<void> | undefined;

  constructor(private readonly tempRoot = join(homedir(), ".lume", "cache", "plugin-packages", "v1")) {}

  async preparePath(input: {
    sourcePath: string;
    packageRoot: string;
    suggestedFilename?: string;
    source: string;
    version?: string;
    ownerWebContentsId: number;
    ownerGeneration: number;
  }): Promise<PreparePluginPackageResult> {
    return withPreparationSlot(async () => {
      await this.ensureInitialized();
      this.cleanupExpired();
      const sourcePath = await assertContainedPath(input.packageRoot, input.sourcePath);
      const tree = await inspectPackageTree(sourcePath);
      reserveTempBytes(tree.size);
      let registered = false;
      const token = createToken();
      const root = join(this.tempRoot, token);
      const suggestedFilename = safeFilename(input.suggestedFilename || basename(sourcePath));
      const payloadPath = join(root, suggestedFilename);
      try {
        await mkdir(root, { recursive: true });
        if (tree.kind === "directory") await cp(sourcePath, payloadPath, { recursive: true, errorOnExist: true, force: false });
        else await copyFile(sourcePath, payloadPath);
        const record = await this.register({
          token, root, payloadPath, kind: tree.kind, suggestedFilename, size: tree.size, reservedSize: tree.size,
          verification: "verified", source: input.source,
          version: input.version,
          ownerWebContentsId: input.ownerWebContentsId, ownerGeneration: input.ownerGeneration,
        });
        registered = true;
        return toPrepareResult(record);
      } catch (error) {
        if (!registered) releaseTempBytes(tree.size);
        await rm(root, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async prepareDownload(input: {
    url: string;
    filename?: string;
    expectedSha256?: string;
    requireSha256: boolean;
    source: string;
    version?: string;
    ownerWebContentsId: number;
    ownerGeneration: number;
  }): Promise<PreparePluginPackageResult> {
    return withPreparationSlot(async () => {
      await this.ensureInitialized();
      this.cleanupExpired();
      if (input.requireSha256 && !input.expectedSha256) {
        throw new PluginPackageError("verify_failed", "官方配套包缺少 SHA-256，已阻止下载");
      }
      if (input.expectedSha256 && !/^[a-f0-9]{64}$/i.test(input.expectedSha256.trim())) {
        throw new PluginPackageError("verify_failed", "配套包 SHA-256 格式非法");
      }
      const token = createToken();
      const root = join(this.tempRoot, token);
      const suggestedFilename = safeFilename(input.filename || basename(new URL(input.url).pathname) || "plugin-package.bin");
      const payloadPath = join(root, suggestedFilename);
      reserveTempBytes(MAX_PACKAGE_BYTES);
      let reservedSize = MAX_PACKAGE_BYTES;
      let registered = false;
      try {
        await mkdir(root, { recursive: true });
        const downloaded = await downloadPublicHttpsFile(input.url, payloadPath);
        releaseTempBytes(MAX_PACKAGE_BYTES - downloaded.size);
        reservedSize = downloaded.size;
        const expected = input.expectedSha256?.trim().toLowerCase();
        if (expected && expected !== downloaded.sha256) {
          throw new PluginPackageError("verify_failed", `SHA-256 校验失败：期望 ${expected}，实际 ${downloaded.sha256}`);
        }
        const record = await this.register({
          token, root, payloadPath, kind: "file", suggestedFilename, size: downloaded.size, reservedSize,
          sha256: downloaded.sha256, verification: expected ? "verified" : "unverified",
          source: input.source, finalOrigin: downloaded.finalOrigin,
          originChanged: downloaded.finalOrigin !== new URL(input.url).origin,
          version: input.version,
          ownerWebContentsId: input.ownerWebContentsId, ownerGeneration: input.ownerGeneration,
        });
        registered = true;
        return toPrepareResult(record);
      } catch (error) {
        if (!registered) releaseTempBytes(reservedSize);
        await rm(root, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async finalize(input: FinalizePluginPackageInput): Promise<{ savedPath: string }> {
    this.cleanupExpired();
    const record = this.requireOwned(input.token, input.ownerWebContentsId, input.ownerGeneration);
    if (record.state !== "ready") throw new PluginPackageError("package_already_consumed", "配套包已被消费或撤销");
    if (!isAbsolute(input.targetPath)) throw new PluginPackageError("unsafe_package", "保存目标必须是绝对路径");
    record.state = "consuming";
    try {
      await replaceTarget(record.payloadPath, input.targetPath, record.kind, input.overwrite === true);
      record.state = "consumed";
      preparedPackages.delete(record.token);
      releaseTempBytes(record.reservedSize);
      await rm(record.root, { recursive: true, force: true }).catch(() => undefined);
      return { savedPath: input.targetPath };
    } catch (error) {
      record.state = "ready";
      throw error;
    }
  }

  async revoke(input: RevokePluginPackageInput): Promise<{ revoked: boolean }> {
    const record = preparedPackages.get(input.token);
    if (!record) return { revoked: false };
    assertOwner(record, input.ownerWebContentsId, input.ownerGeneration);
    if (record.state === "consuming") throw new PluginPackageError("package_already_consumed", "配套包正在保存");
    record.state = "revoked";
    preparedPackages.delete(record.token);
    releaseTempBytes(record.reservedSize);
    await rm(record.root, { recursive: true, force: true });
    return { revoked: true };
  }

  private async register(input: Omit<PreparedPackageRecord, "sha256" | "expiresAt" | "state"> & { sha256?: string }): Promise<PreparedPackageRecord> {
    const record: PreparedPackageRecord = {
      ...input,
      sha256: input.sha256 ?? (input.kind === "file" ? await hashFile(input.payloadPath) : await hashDirectory(input.payloadPath)),
      expiresAt: Date.now() + TOKEN_TTL_MS,
      state: "ready",
    };
    preparedPackages.set(record.token, record);
    return record;
  }

  private requireOwned(token: string, ownerWebContentsId: number, ownerGeneration: number): PreparedPackageRecord {
    const record = preparedPackages.get(token);
    if (!record) throw new PluginPackageError("package_not_found", "配套包 token 不存在");
    if (record.expiresAt <= Date.now()) {
      preparedPackages.delete(token);
      releaseTempBytes(record.reservedSize);
      void rm(record.root, { recursive: true, force: true });
      throw new PluginPackageError("package_expired", "配套包 token 已过期");
    }
    assertOwner(record, ownerWebContentsId, ownerGeneration);
    return record;
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [token, record] of preparedPackages) {
      if (record.expiresAt > now || record.state === "consuming") continue;
      preparedPackages.delete(token);
      releaseTempBytes(record.reservedSize);
      void rm(record.root, { recursive: true, force: true });
    }
  }

  private ensureInitialized(): Promise<void> {
    this.initialization ??= (async () => {
      await mkdir(this.tempRoot, { recursive: true });
      const activeRoots = new Set(
        [...preparedPackages.values()].map((record) => resolve(record.root)),
      );
      for (const entry of await readdir(this.tempRoot, { withFileTypes: true })) {
        const path = join(this.tempRoot, entry.name);
        if (!activeRoots.has(resolve(path))) await rm(path, { recursive: true, force: true });
      }
    })();
    return this.initialization;
  }
}

let defaultService: PluginPackageService | undefined;
export function getPluginPackageService(): PluginPackageService {
  defaultService ??= new PluginPackageService();
  return defaultService;
}

async function assertContainedPath(rootPath: string, candidatePath: string): Promise<string> {
  const lexicalRoot = resolve(rootPath);
  const lexicalCandidate = resolve(candidatePath);
  const lexicalRelative = relative(lexicalRoot, lexicalCandidate);
  if (lexicalRelative.startsWith("..") || isAbsolute(lexicalRelative)) throw new PluginPackageError("unsafe_package", "配套包路径越界");
  let cursor = lexicalRoot;
  for (const segment of lexicalRelative.split(/[\\/]+/).filter(Boolean)) {
    cursor = join(cursor, segment);
    if ((await lstat(cursor)).isSymbolicLink()) throw new PluginPackageError("unsafe_package", "配套包路径不允许符号链接");
  }
  const root = await realpath(lexicalRoot);
  const candidate = await realpath(lexicalCandidate);
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new PluginPackageError("unsafe_package", "配套包路径越界");
  return candidate;
}

async function inspectPackageTree(path: string): Promise<{ kind: "file" | "directory"; size: number }> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new PluginPackageError("unsafe_package", "配套包不允许符号链接");
  if (info.isFile()) {
    if (info.nlink > 1) throw new PluginPackageError("unsafe_package", "配套包不允许硬链接");
    if (info.size > MAX_PACKAGE_BYTES) throw new PluginPackageError("unsafe_package", "配套包超过大小限制");
    return { kind: "file", size: info.size };
  }
  if (!info.isDirectory()) throw new PluginPackageError("unsafe_package", "配套包必须是文件或目录");
  let size = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    size += (await inspectPackageTree(join(path, entry.name))).size;
    if (size > MAX_PACKAGE_BYTES) throw new PluginPackageError("unsafe_package", "配套包超过大小限制");
  }
  return { kind: "directory", size };
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function hashDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(path: string, prefix: string): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      hash.update(rel).update("\0");
      if (entry.isDirectory()) await walk(join(path, entry.name), rel);
      else hash.update(await hashFile(join(path, entry.name)));
    }
  }
  await walk(root, "");
  return hash.digest("hex");
}

async function replaceTarget(source: string, target: string, kind: "file" | "directory", overwrite: boolean): Promise<void> {
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const stage = join(parent, `.${basename(target)}.lume-stage-${randomUUID()}`);
  const backup = join(parent, `.${basename(target)}.lume-backup-${randomUUID()}`);
  const targetExists = existsSync(target);
  if (targetExists && !overwrite) throw new PluginPackageError("target_exists", "目标已存在");
  try {
    if (kind === "directory") await cp(source, stage, { recursive: true, errorOnExist: true, force: false });
    else await copyFile(source, stage);
    if (targetExists) await rename(target, backup);
    try {
      await rename(stage, target);
    } catch (error) {
      if (targetExists && existsSync(backup) && !existsSync(target)) await rename(backup, target);
      throw error;
    }
    if (targetExists) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function downloadPublicHttpsFile(inputUrl: string, targetPath: string, redirects = 0): Promise<{ size: number; sha256: string; finalOrigin: string }> {
  if (redirects > MAX_REDIRECTS) throw new PluginPackageError("download_failed", "下载重定向次数过多");
  const url = new URL(inputUrl);
  if (url.protocol !== "https:" || url.username || url.password) throw new PluginPackageError("download_failed", "配套包只允许无凭据的 HTTPS URL");
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new PluginPackageError("download_failed", "下载地址解析到非公网地址");
  }
  const pinned = addresses[0]!;
  return new Promise((resolveDownload, rejectDownload) => {
    const request = httpsRequest(url, {
      headers: { "User-Agent": "Lume-Plugin-Market", Accept: "application/octet-stream" },
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
      timeout: REQUEST_TIMEOUT_MS,
    }, async (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        try { resolveDownload(await downloadPublicHttpsFile(new URL(location, url).toString(), targetPath, redirects + 1)); }
        catch (error) { rejectDownload(error); }
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        rejectDownload(new PluginPackageError("download_failed", `下载失败：HTTP ${status}`));
        return;
      }
      const declared = Number(response.headers["content-length"] ?? 0);
      if (Number.isFinite(declared) && declared > MAX_PACKAGE_BYTES) {
        response.destroy();
        rejectDownload(new PluginPackageError("download_failed", "配套包超过大小限制"));
        return;
      }
      const hash = createHash("sha256");
      let size = 0;
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          if (size > MAX_PACKAGE_BYTES) return callback(new PluginPackageError("download_failed", "配套包超过大小限制"));
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(response, meter, createWriteStream(targetPath, { flags: "wx" }));
        resolveDownload({ size, sha256: hash.digest("hex"), finalOrigin: url.origin });
      } catch (error) { rejectDownload(error); }
    });
    request.on("timeout", () => request.destroy(new PluginPackageError("download_failed", "配套包下载超时")));
    request.on("error", rejectDownload);
    request.end();
  });
}

function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split(".").map(Number);
    const a = octets[0] ?? -1;
    const b = octets[1] ?? -1;
    const c = octets[2] ?? -1;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if ((a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return false;
    return true;
  }
  if (version === 6) {
    const value = address.toLowerCase();
    if (value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") || /^fe[89ab]/.test(value) || value.startsWith("ff") || value.startsWith("2001:db8")) return false;
    const mapped = /(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value)?.[1];
    return mapped ? isPublicAddress(mapped) : true;
  }
  return false;
}

function assertOwner(record: PreparedPackageRecord, ownerWebContentsId: number, ownerGeneration: number): void {
  if (record.ownerWebContentsId !== ownerWebContentsId || record.ownerGeneration !== ownerGeneration) {
    throw new PluginPackageError("package_owner_mismatch", "配套包 token 不属于当前窗口");
  }
}

function createToken(): string { return randomUUID().replaceAll("-", ""); }

async function withPreparationSlot<T>(action: () => Promise<T>): Promise<T> {
  if (activePreparations >= MAX_CONCURRENT_PREPARATIONS) {
    throw new PluginPackageError("resource_busy", "同时准备的配套包过多，请稍后重试");
  }
  activePreparations++;
  try { return await action(); }
  finally { activePreparations--; }
}

function reserveTempBytes(size: number): void {
  if (size < 0 || reservedTempBytes + size > MAX_RESERVED_TEMP_BYTES) {
    throw new PluginPackageError("quota_exceeded", "插件配套包临时空间配额不足");
  }
  reservedTempBytes += size;
}

function releaseTempBytes(size: number): void {
  reservedTempBytes = Math.max(0, reservedTempBytes - Math.max(0, size));
}

function safeFilename(value: string): string {
  const name = basename(value.trim()).replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-").replace(/[. ]+$/g, "");
  if (!name || name === "." || name === "..") return "plugin-package";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) return `_${name}`;
  return name.slice(0, 160);
}

function toPrepareResult(record: PreparedPackageRecord): PreparePluginPackageResult {
  return {
    token: record.token,
    kind: record.kind,
    suggestedFilename: record.suggestedFilename,
    size: record.size,
    source: record.source,
    verification: record.verification,
    sha256: record.sha256,
    ...(record.version ? { version: record.version } : {}),
    ...(record.finalOrigin ? { finalOrigin: record.finalOrigin } : {}),
    ...(record.originChanged ? { originChanged: true } : {}),
  };
}
