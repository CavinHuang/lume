"use client";

import { Paperclip, X } from "lucide-react";
import { cn } from "@/lib/utils";

type AttachmentPreviewItemProps = {
  filename: string;
  mediaType: string;
  previewUrl?: string;
  onRemove: () => void;
  className?: string;
};

function isImage(mediaType: string): boolean {
  return mediaType.startsWith("image/");
}

function truncateName(name: string, max = 20): string {
  return name.length > max ? `${name.slice(0, max - 3)}...` : name;
}

export function AttachmentPreviewItem({
  filename,
  mediaType,
  previewUrl,
  onRemove,
  className
}: AttachmentPreviewItemProps): React.ReactElement {
  if (isImage(mediaType) && previewUrl) {
    return (
      <div className={cn("group/attachment relative size-[72px] shrink-0 overflow-hidden rounded-lg", className)}>
        <img src={previewUrl} alt={filename} className="size-full object-cover" />
        <button
          type="button"
          onClick={onRemove}
          className={cn(
            "absolute right-1 top-1 flex size-[18px] items-center justify-center rounded-full",
            "bg-black/50 text-white opacity-0 backdrop-blur-sm transition-opacity duration-200",
            "group-hover/attachment:opacity-100 hover:bg-black/70"
          )}
        >
          <X className="size-3" />
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group/attachment relative flex shrink-0 items-center gap-2 rounded-lg border border-[#37a5aa]/20 bg-[#37a5aa]/10",
        "py-1.5 pl-2.5 pr-7 text-[13px] text-[#37a5aa] transition-colors hover:bg-[#37a5aa]/15",
        className
      )}
    >
      <Paperclip className="size-4 shrink-0" />
      <span className="max-w-[160px] truncate">{truncateName(filename)}</span>
      <button
        type="button"
        onClick={onRemove}
        className={cn(
          "absolute right-1.5 top-1/2 flex size-[18px] -translate-y-1/2 items-center justify-center rounded-full",
          "text-[#37a5aa]/60 opacity-0 transition-all duration-200 group-hover/attachment:opacity-100",
          "hover:bg-[#37a5aa]/20 hover:text-[#37a5aa]"
        )}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
