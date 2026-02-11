/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\channel-manager.ts
 * Adaptation:
 * - Replaced Electron safeStorage with Node crypto AES-256-GCM for sidecar.
 * - Kept channel CRUD and model/test APIs for MIG-004 compatibility.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getChannelsPath } from "./config-paths";
import type {
  Channel,
  ChannelCreateInput,
  ChannelModel,
  ChannelsConfig,
  ChannelTestResult,
  ChannelUpdateInput,
  FetchModelsInput,
  FetchModelsResult
} from "@lume/shared";

const CONFIG_VERSION = 1;
const AES_ALGO = "aes-256-gcm";

function getEncryptionKey(): Buffer {
  const seed = process.env.LUME_SECRET_SEED ?? `${process.env.USERNAME ?? "user"}::${process.env.HOME ?? "home"}::lume`;
  return createHash("sha256").update(seed).digest();
}

function encryptApiKey(plainKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(AES_ALGO, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainKey, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptKey(encryptedKey: string): string {
  const data = Buffer.from(encryptedKey, "base64");
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = createDecipheriv(AES_ALGO, getEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function readConfig(): ChannelsConfig {
  const configPath = getChannelsPath();
  if (!existsSync(configPath)) return { version: CONFIG_VERSION, channels: [] };
  try {
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as ChannelsConfig;
  } catch (error) {
    console.error("[渠道管理] 读取配置文件失败:", error);
    return { version: CONFIG_VERSION, channels: [] };
  }
}

function writeConfig(config: ChannelsConfig): void {
  const configPath = getChannelsPath();
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

export function listChannels(): Channel[] {
  return readConfig().channels;
}

export function getChannelById(id: string): Channel | undefined {
  return readConfig().channels.find((c) => c.id === id);
}

export function createChannel(input: ChannelCreateInput): Channel {
  const config = readConfig();
  const now = Date.now();
  const channel: Channel = {
    id: randomUUID(),
    name: input.name,
    provider: input.provider,
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ""),
    apiKey: encryptApiKey(input.apiKey),
    models: input.models,
    enabled: input.enabled,
    createdAt: now,
    updatedAt: now
  };
  config.channels.push(channel);
  writeConfig(config);
  return channel;
}

export function updateChannel(id: string, input: ChannelUpdateInput): Channel {
  const config = readConfig();
  const idx = config.channels.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error(`渠道不存在: ${id}`);
  const existing = config.channels[idx] as Channel;
  const updated: Channel = {
    ...existing,
    ...input,
    baseUrl: input.baseUrl ? input.baseUrl.trim().replace(/\/+$/, "") : existing.baseUrl,
    apiKey: input.apiKey ? encryptApiKey(input.apiKey) : existing.apiKey,
    updatedAt: Date.now()
  };
  config.channels[idx] = updated;
  writeConfig(config);
  return updated;
}

export function deleteChannel(id: string): void {
  const config = readConfig();
  const idx = config.channels.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error(`渠道不存在: ${id}`);
  config.channels.splice(idx, 1);
  writeConfig(config);
}

export function decryptApiKey(channelId: string): string {
  const channel = getChannelById(channelId);
  if (!channel) throw new Error(`渠道不存在: ${channelId}`);
  return decryptKey(channel.apiKey);
}

function normalizeAnthropicBaseUrl(baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, "");
  if (!url.match(/\/v\d+$/)) url = `${url}/v1`;
  return url;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

async function testAnthropic(baseUrl: string, apiKey: string): Promise<ChannelTestResult> {
  const url = normalizeAnthropicBaseUrl(baseUrl);
  const response = await fetch(`${url}/messages`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      Authorization: `Bearer ${apiKey}`,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }]
    })
  });
  if (response.ok) return { success: true, message: "连接成功" };
  if (response.status === 401) return { success: false, message: "API Key 无效" };
  return { success: false, message: `请求失败 (${response.status})` };
}

async function testOpenAICompatible(baseUrl: string, apiKey: string): Promise<ChannelTestResult> {
  const url = normalizeBaseUrl(baseUrl);
  const response = await fetch(`${url}/models`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (response.ok) return { success: true, message: "连接成功" };
  if (response.status === 401) return { success: false, message: "API Key 无效" };
  return { success: false, message: `请求失败 (${response.status})` };
}

async function testGoogle(baseUrl: string, apiKey: string): Promise<ChannelTestResult> {
  const url = normalizeBaseUrl(baseUrl);
  const response = await fetch(`${url}/v1beta/models?key=${apiKey}`, { method: "GET" });
  if (response.ok) return { success: true, message: "连接成功" };
  if (response.status === 400 || response.status === 403) return { success: false, message: "API Key 无效" };
  return { success: false, message: `请求失败 (${response.status})` };
}

export async function testChannel(channelId: string): Promise<ChannelTestResult> {
  const channel = getChannelById(channelId);
  if (!channel) return { success: false, message: "渠道不存在" };
  const apiKey = decryptKey(channel.apiKey);
  if (channel.provider === "anthropic") return testAnthropic(channel.baseUrl, apiKey);
  if (channel.provider === "google") return testGoogle(channel.baseUrl, apiKey);
  return testOpenAICompatible(channel.baseUrl, apiKey);
}

export async function testChannelDirect(input: FetchModelsInput): Promise<ChannelTestResult> {
  if (input.provider === "anthropic") return testAnthropic(input.baseUrl, input.apiKey);
  if (input.provider === "google") return testGoogle(input.baseUrl, input.apiKey);
  return testOpenAICompatible(input.baseUrl, input.apiKey);
}

interface OpenAIModelItem {
  id: string;
}

interface AnthropicModelItem {
  id: string;
  display_name?: string;
}

interface GoogleModelItem {
  name: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
}

async function fetchOpenAICompatibleModels(baseUrl: string, apiKey: string): Promise<FetchModelsResult> {
  const url = normalizeBaseUrl(baseUrl);
  const response = await fetch(`${url}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) return { success: false, message: `请求失败 (${response.status})`, models: [] };
  const data = (await response.json()) as { data?: OpenAIModelItem[] };
  const models: ChannelModel[] = (data.data ?? []).map((item) => ({ id: item.id, name: item.id, enabled: true }));
  return { success: true, message: `成功获取 ${models.length} 个模型`, models };
}

async function fetchAnthropicModels(baseUrl: string, apiKey: string): Promise<FetchModelsResult> {
  const url = normalizeAnthropicBaseUrl(baseUrl);
  const response = await fetch(`${url}/models`, {
    headers: {
      "x-api-key": apiKey,
      Authorization: `Bearer ${apiKey}`,
      "anthropic-version": "2023-06-01"
    }
  });
  if (!response.ok) return { success: false, message: `请求失败 (${response.status})`, models: [] };
  const data = (await response.json()) as { data?: AnthropicModelItem[] };
  const models: ChannelModel[] = (data.data ?? []).map((item) => ({
    id: item.id,
    name: item.display_name ?? item.id,
    enabled: true
  }));
  return { success: true, message: `成功获取 ${models.length} 个模型`, models };
}

async function fetchGoogleModels(baseUrl: string, apiKey: string): Promise<FetchModelsResult> {
  const url = normalizeBaseUrl(baseUrl);
  const response = await fetch(`${url}/v1beta/models?key=${apiKey}`);
  if (!response.ok) return { success: false, message: `请求失败 (${response.status})`, models: [] };
  const data = (await response.json()) as { models?: GoogleModelItem[] };
  const models: ChannelModel[] = (data.models ?? [])
    .filter((item) => item.supportedGenerationMethods?.includes("generateContent"))
    .map((item) => {
      const id = item.name.replace(/^models\//, "");
      return { id, name: item.displayName ?? id, enabled: true };
    });
  return { success: true, message: `成功获取 ${models.length} 个模型`, models };
}

export async function fetchModels(input: FetchModelsInput): Promise<FetchModelsResult> {
  if (input.provider === "anthropic") return fetchAnthropicModels(input.baseUrl, input.apiKey);
  if (input.provider === "google") return fetchGoogleModels(input.baseUrl, input.apiKey);
  return fetchOpenAICompatibleModels(input.baseUrl, input.apiKey);
}
