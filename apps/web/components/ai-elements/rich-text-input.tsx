import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type RichTextInputProps = {
  value: string;
  onChange: (value: string) => void;
  onPasteFiles?: (files: File[]) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  onSubmit: () => void;
};

type EnterSubmitGuardInput = {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  nativeIsComposing?: boolean;
  nativeKeyCode?: number;
};

export function shouldSubmitOnEnter(input: EnterSubmitGuardInput): boolean {
  if (input.key === "Process") {
    return false;
  }

  if (input.key !== "Enter" || input.shiftKey) {
    return false;
  }

  if (input.isComposing || input.nativeIsComposing) {
    return false;
  }

  // Windows/Chromium IME may emit Enter while selecting candidates with keyCode 229 or key "Process".
  if (input.nativeKeyCode === 229) {
    return false;
  }

  return true;
}

export function RichTextInput({
  value,
  onChange,
  onPasteFiles,
  placeholder = "输入内容...",
  disabled,
  className,
  onSubmit
}: RichTextInputProps): React.ReactElement {
  const [isComposing, setIsComposing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = "0px";
    textareaRef.current.style.height = `${Math.max(90, textareaRef.current.scrollHeight)}px`;
  }, [value]);

  return (
    <div className={cn("px-4", className)}>
      <textarea
        ref={textareaRef}
        className="min-h-[90px] w-full resize-none bg-transparent px-0 py-2 text-sm outline-none placeholder:text-muted-foreground/50"
        rows={3}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => setIsComposing(false)}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files ?? []);
          if (files.length > 0 && onPasteFiles) {
            event.preventDefault();
            onPasteFiles(files);
          }
        }}
        onKeyDown={(event) => {
          if (shouldSubmitOnEnter({
            key: event.key,
            shiftKey: event.shiftKey,
            isComposing,
            nativeIsComposing: event.nativeEvent.isComposing,
            nativeKeyCode: event.nativeEvent.keyCode
          })) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
    </div>
  );
}
