"use client";

import { useRef, useState } from "react";
import { useAtom } from "jotai";
import { Camera, ImagePlus } from "lucide-react";
import { userProfileAtom, persistUserProfile } from "@/atoms";
import { UserAvatar } from "@/components/chat/UserAvatar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { SettingsCard, SettingsRow, SettingsSection } from "./primitives";

const QUICK_AVATARS = ["🙂", "😎", "🤖", "🧠", "🛠️", "🔥", "🚀", "🐱", "🦊", "🌟"];

export function GeneralSettings(): React.ReactElement {
  const [userProfile, setUserProfile] = useAtom(userProfileAtom);
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(userProfile.userName);
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
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
              <PopoverContent side="right" align="start" sideOffset={12} className="w-[280px] p-3">
                <div className="mb-2 text-xs text-muted-foreground">选择头像</div>
                <div className="mb-3 grid grid-cols-5 gap-1.5">
                  {QUICK_AVATARS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      className="rounded-md bg-muted px-2 py-1.5 text-lg transition-colors hover:bg-muted/70"
                      onClick={() => handleAvatarChange(emoji)}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg py-2 text-[13px] text-foreground/60 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
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
                  className="w-full max-w-[220px] border-b-2 border-primary bg-transparent pb-0.5 text-lg font-semibold text-foreground outline-none"
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
          <SettingsRow label="语言" description="更多语言支持即将推出">
            <span className="text-[13px] text-foreground/40">简体中文</span>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
