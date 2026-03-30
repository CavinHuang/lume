import { CheckCircle2, CircleDashed, Compass, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";

interface OnboardingViewProps {
  hasModelSelected: boolean;
  hasPromptConfig: boolean;
  hasToolsEnabled: boolean;
  creating: boolean;
  onCreateWelcomeConversation: () => void;
  onOpenModelSettings: () => void;
  onDismiss: () => void;
}

function StatusItem({ label, ok }: { label: string; ok: boolean }): React.ReactElement {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      {ok ? <CheckCircle2 className="size-4 text-emerald-600" /> : <CircleDashed className="size-4" />}
      <span>{label}</span>
    </div>
  );
}

export function OnboardingView({
  hasModelSelected,
  hasPromptConfig,
  hasToolsEnabled,
  creating,
  onCreateWelcomeConversation,
  onOpenModelSettings,
  onDismiss
}: OnboardingViewProps): React.ReactElement {
  return (
    <div className="mx-auto flex h-full w-full max-w-[min(72rem,100%)] flex-col items-center justify-center px-6">
      <div className="w-full max-w-xl rounded-2xl border bg-background/95 p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-3">
          <div className="rounded-xl bg-primary/10 p-2 text-primary">
            <Compass className="size-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">欢迎使用 Lume</h2>
            <p className="text-sm text-muted-foreground">先完成最小环境检查，然后创建一个欢迎对话开始体验。</p>
          </div>
        </div>

        <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
          <StatusItem label="已选择可用模型" ok={hasModelSelected} />
          <StatusItem label="系统提示词已就绪" ok={hasPromptConfig} />
          <StatusItem label="工具能力可用（可选）" ok={hasToolsEnabled} />
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={onCreateWelcomeConversation}
            disabled={creating || !hasModelSelected}
          >
            {creating ? "创建中..." : "创建欢迎对话"}
          </Button>
          <Button type="button" variant="outline" onClick={onOpenModelSettings}>
            打开模型设置
          </Button>
          <Button type="button" variant="ghost" onClick={onDismiss}>
            稍后再说
          </Button>
        </div>

        {!hasModelSelected ? (
          <p className="mt-3 text-xs text-amber-700">
            未检测到已选模型，先到设置页完成模型配置后再创建欢迎对话。
          </p>
        ) : null}

        <div className="mt-4 flex items-center gap-1 text-xs text-muted-foreground">
          <Wrench className="size-3.5" />
          <span>该引导为轻量模式，不会覆盖你已有对话或配置。</span>
        </div>
      </div>
    </div>
  );
}
