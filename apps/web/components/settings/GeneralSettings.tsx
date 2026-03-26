"use client";

import { useEffect, useRef, useState } from "react";
import { useAtom } from "jotai";
import { Camera, ImagePlus } from "lucide-react";
import Picker from "@emoji-mart/react";
import data from "@emoji-mart/data";
import type { AgentProxySettings, AgentProxyStatus } from "@lume/shared";
import { userProfileAtom, persistUserProfile, themeModeAtom, persistThemeMode, type ThemeMode } from "@/atoms";
import { UserAvatar } from "@/components/chat/UserAvatar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { getAgentProxySettings, saveAgentProxySettings } from "@/lib/desktop-api/agent";
import { SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSegmentedControl, SettingsSelect } from "./primitives";

interface EmojiMartEmoji {
  id: string;
  name: string;
  native: string;
  unified: string;
  keywords: string[];
  shortcodes: string;
}

const THEME_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" }
];

export function GeneralSettings(): React.ReactElement {
  const [userProfile, setUserProfile] = useAtom(userProfileAtom);
  const [themeMode, setThemeMode] = useAtom(themeModeAtom);
  const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
  const zoomHint = isMac
    ? "使用 ⌘+ 放大、⌘- 缩小、⌘0 恢复默认大小"
    : "使用 Ctrl++ 放大、Ctrl+- 缩小、Ctrl+0 恢复默认大小";
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(userProfile.userName);
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
  const [proxyStatus, setProxyStatus] = useState<AgentProxyStatus | null>(null);
  const [proxyDraft, setProxyDraft] = useState<AgentProxySettings>({
    version: 1,
    enabled: false,
    mode: "off"
  });
  const [savingProxy, setSavingProxy] = useState(false);
  const [proxyError, setProxyError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const commitProfile = (next: typeof userProfile): void => {
    setUserProfile(next);
    persistUserProfile(next);
  };

  const handleAvatarChange = (avatar: string): void => {
    commitProfile({ ...userProfile, avatar });
    setShowAvatarPicker(false);
  };

  const handleImageUpload = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      if (dataUrl) {
        handleAvatarChange(dataUrl);
      }
    };
    reader.readAsDataURL(file);
    event.target.value = "";
  };

  const handleSaveName = (): void => {
    const trimmed = nameInput.trim();
    if (!trimmed) return;
    commitProfile({ ...userProfile, userName: trimmed });
    setIsEditingName(false);
  };

  const loadProxySettings = async (): Promise<void> => {
    try {
      const status = await getAgentProxySettings();
      setProxyStatus(status);
      setProxyDraft(status.settings);
    } catch (error) {
      setProxyError(error instanceof Error ? error.message : String(error));
    }
  };

  const persistProxySettings = async (next: AgentProxySettings): Promise<void> => {
    setSavingProxy(true);
    setProxyError(null);
    try {
      const status = await saveAgentProxySettings(next);
      setProxyStatus(status);
      setProxyDraft(status.settings);
    } catch (error) {
      setProxyError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingProxy(false);
    }
  };

  useEffect(() => {
    void loadProxySettings();
  }, []);

  return (
    <div className="space-y-6">
      <SettingsSection title="用户档案" description="设置你的头像和显示名称">
        <SettingsCard>
          <div className="flex items-center gap-5 px-4 py-4">
            <Popover open={showAvatarPicker} onOpenChange={setShowAvatarPicker}>
              <PopoverTrigger asChild>
                <div className="group/avatar relative cursor-pointer">
                  <UserAvatar avatar={userProfile.avatar} size={64} />
                  <div
                    className={cn(
                      "absolute inset-0 flex items-center justify-center rounded-[20%] bg-black/40 opacity-0 transition-opacity",
                      "group-hover/avatar:opacity-100"
                    )}
                  >
                    <Camera className="size-5 text-white" />
                  </div>
                </div>
              </PopoverTrigger>
              <PopoverContent
                side="right"
                align="start"
                sideOffset={12}
                className="w-auto border-none p-0 shadow-xl"
              >
                <Picker
                  data={data}
                  onEmojiSelect={(emoji: EmojiMartEmoji) => handleAvatarChange(emoji.native)}
                  locale="zh"
                  theme="auto"
                  previewPosition="none"
                  skinTonePosition="search"
                  perLine={8}
                />
                <div className="p-2 px-3">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className={cn(
                      "flex w-full items-center justify-center gap-1.5 rounded-lg py-2 text-[13px]",
                      "text-foreground/60 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                    )}
                  >
                    <ImagePlus className="size-4" />
                    上传自定义图片
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    className="hidden"
                    onChange={handleImageUpload}
                  />
                </div>
              </PopoverContent>
            </Popover>

            <div className="min-w-0 flex-1">
              {isEditingName ? (
                <input
                  type="text"
                  value={nameInput}
                  onChange={(event) => setNameInput(event.target.value)}
                  onBlur={handleSaveName}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") handleSaveName();
                    if (event.key === "Escape") {
                      setNameInput(userProfile.userName);
                      setIsEditingName(false);
                    }
                  }}
                  maxLength={30}
                  autoFocus
                  className="w-full max-w-[200px] border-b-2 border-primary bg-transparent pb-0.5 text-lg font-semibold text-foreground outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setNameInput(userProfile.userName);
                    setIsEditingName(true);
                  }}
                  className="text-left text-lg font-semibold text-foreground transition-colors hover:text-primary"
                >
                  {userProfile.userName}
                </button>
              )}
              <p className="mt-0.5 text-[12px] text-foreground/40">点击头像更换，点击名字编辑</p>
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="通用设置" description="应用的基本配置">
        <SettingsCard>
          <SettingsSegmentedControl
            label="主题模式"
            description="选择应用的配色方案"
            value={themeMode}
            onValueChange={(value) => {
              const next = value as ThemeMode;
              setThemeMode(next);
              persistThemeMode(next);
            }}
            options={THEME_OPTIONS}
          />
          <SettingsRow label="语言" description="更多语言支持即将推出">
            <span className="text-[13px] text-foreground/40">简体中文</span>
          </SettingsRow>
          <SettingsRow label="界面缩放" description={zoomHint} />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="网络代理" description="用于 web_search / web_fetch 等网络工具请求">
        <SettingsCard>
          <SettingsRow
            label="启用代理"
            description="开启后默认使用系统代理配置（环境变量）。"
          >
            <Button
              type="button"
              size="sm"
              variant={proxyDraft.enabled ? "default" : "outline"}
              disabled={savingProxy}
              onClick={() => {
                const enabled = !proxyDraft.enabled;
                const next: AgentProxySettings = enabled
                  ? { ...proxyDraft, enabled: true, mode: proxyDraft.mode === "off" ? "system" : proxyDraft.mode }
                  : { ...proxyDraft, enabled: false, mode: "off" };
                setProxyDraft(next);
                void persistProxySettings(next);
              }}
            >
              {proxyDraft.enabled ? "已开启" : "已关闭"}
            </Button>
          </SettingsRow>

          <SettingsSelect
            label="代理模式"
            description="system: 跟随系统/环境变量；custom: 手动填写代理地址。"
            value={proxyDraft.mode}
            disabled={!proxyDraft.enabled || savingProxy}
            onValueChange={(value) => {
              const mode = value === "custom" ? "custom" : value === "system" ? "system" : "off";
              const next: AgentProxySettings = {
                ...proxyDraft,
                mode,
                enabled: mode !== "off"
              };
              setProxyDraft(next);
              void persistProxySettings(next);
            }}
            options={[
              { value: "system", label: "系统代理（推荐）" },
              { value: "custom", label: "自定义代理" },
              { value: "off", label: "关闭代理" }
            ]}
          />

          {proxyDraft.mode === "custom" && proxyDraft.enabled ? (
            <>
              <SettingsInput
                label="HTTP_PROXY"
                description="示例: http://127.0.0.1:7890"
                value={proxyDraft.httpProxy ?? ""}
                onChange={(value) => setProxyDraft((prev) => ({ ...prev, httpProxy: value }))}
                disabled={savingProxy}
              />
              <SettingsInput
                label="HTTPS_PROXY"
                description="为空时自动复用 HTTP_PROXY"
                value={proxyDraft.httpsProxy ?? ""}
                onChange={(value) => setProxyDraft((prev) => ({ ...prev, httpsProxy: value }))}
                disabled={savingProxy}
              />
              <SettingsInput
                label="NO_PROXY"
                description="逗号分隔域名，如 localhost,127.0.0.1"
                value={proxyDraft.noProxy ?? ""}
                onChange={(value) => setProxyDraft((prev) => ({ ...prev, noProxy: value }))}
                disabled={savingProxy}
              />
              <div className="px-4 pb-4">
                <Button
                  type="button"
                  size="sm"
                  disabled={savingProxy}
                  onClick={() => void persistProxySettings(proxyDraft)}
                >
                  保存代理配置
                </Button>
              </div>
            </>
          ) : null}

          {proxyStatus?.systemProxy ? (
            <div className="px-4 pb-4 text-xs text-muted-foreground">
              系统代理
              {`: http=${proxyStatus.systemProxy.httpProxy ?? "-"}, https=${proxyStatus.systemProxy.httpsProxy ?? "-"}, no_proxy=${proxyStatus.systemProxy.noProxy ?? "-"}`}
            </div>
          ) : null}
          {proxyError ? <div className="px-4 pb-4 text-xs text-destructive">{proxyError}</div> : null}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
