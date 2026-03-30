import { cn } from "@/lib/utils";

type UserAvatarProps = {
  avatar?: string;
  size?: number;
  className?: string;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
};

function isImageUrl(avatar: string): boolean {
  return avatar.startsWith("data:image") || avatar.startsWith("http");
}

export function UserAvatar({
  avatar = "🙂",
  size = 35,
  className,
  onClick
}: UserAvatarProps): React.ReactElement {
  const fontSize = Math.round(size * 0.5);

  if (isImageUrl(avatar)) {
    return (
      <div
        className={cn(
          "shrink-0 overflow-hidden rounded-[20%] border-[0.5px] border-foreground/10",
          onClick ? "cursor-pointer transition-opacity hover:opacity-80" : undefined,
          className
        )}
        style={{ width: size, height: size }}
        onClick={onClick}
      >
        <img src={avatar} alt="用户头像" className="size-full object-cover" />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "shrink-0 flex items-center justify-center rounded-[20%]",
        "border-[0.5px] border-foreground/10 bg-foreground/[0.04] dark:bg-foreground/[0.08]",
        onClick ? "cursor-pointer transition-opacity hover:opacity-80" : undefined,
        className
      )}
      style={{ width: size, height: size, fontSize }}
      onClick={onClick}
    >
      {avatar}
    </div>
  );
}
