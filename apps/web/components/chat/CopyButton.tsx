import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";

type CopyButtonProps = {
  content: string;
};

export function CopyButton({ content }: CopyButtonProps): React.ReactElement {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground/50 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
      onClick={() => {
        void navigator.clipboard.writeText(content);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
      title="复制"
    >
      {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
    </button>
  );
}
