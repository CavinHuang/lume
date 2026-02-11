"use client";

type UserAvatarProps = {
  avatar?: string;
  size?: number;
};

export function UserAvatar({ avatar = "🙂", size = 28 }: UserAvatarProps): React.ReactElement {
  return (
    <span
      style={{ width: size, height: size, minWidth: size, minHeight: size }}
      className="inline-flex items-center justify-center rounded-full border border-slate-700 bg-slate-800"
    >
      {avatar}
    </span>
  );
}
