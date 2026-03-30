import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

interface TutorialBannerProps {
  canSendExample: boolean;
  onSendExample: () => void;
  onOpenModelSettings: () => void;
  onDismiss: () => void;
}

export function TutorialBanner({
  canSendExample,
  onSendExample,
  onOpenModelSettings,
  onDismiss
}: TutorialBannerProps): React.ReactElement {
  return (
    <div className="mx-4 mt-2 rounded-xl border bg-muted/30 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-1.5 text-sm font-medium">
            <Sparkles className="size-4 text-primary" />
            快速引导
          </div>
          <p className="text-xs text-muted-foreground">
            你可以先发一条示例问题，或先去设置页检查模型与工具。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onSendExample}
            disabled={!canSendExample}
          >
            发送示例问题
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onOpenModelSettings}>
            模型设置
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
            关闭
          </Button>
        </div>
      </div>
    </div>
  );
}
