"use client";

import { useAtom } from "jotai";
import { userProfileAtom, persistUserProfile } from "@/atoms";
import { SettingsCard, SettingsInput, SettingsSection } from "./primitives";

export function GeneralSettings(): React.ReactElement {
  const [profile, setProfile] = useAtom(userProfileAtom);

  return (
    <div className="flex flex-col gap-4">
      <SettingsSection title="用户档案" description="设置你的昵称与头像（本地存储）">
        <SettingsCard>
          <SettingsInput
            label="昵称"
            value={profile.userName}
            onChange={(value) => {
              const next = { ...profile, userName: value };
              setProfile(next);
              persistUserProfile(next);
            }}
            placeholder="例如：Kevin"
          />
          <SettingsInput
            label="头像"
            description="支持 emoji 或任意短文本"
            value={profile.avatar}
            onChange={(value) => {
              const next = { ...profile, avatar: value };
              setProfile(next);
              persistUserProfile(next);
            }}
            placeholder="🙂"
          />
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
