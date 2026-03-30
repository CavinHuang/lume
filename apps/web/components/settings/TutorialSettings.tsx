import { useAtom } from "jotai";
import { onboardingCompletedAtom, onboardingDismissedAtom } from "@/atoms";
import { Button } from "@/components/ui/button";

export function TutorialSettings(): React.ReactElement {
  const [onboardingDismissed, setOnboardingDismissed] = useAtom(onboardingDismissedAtom);
  const [onboardingCompleted, setOnboardingCompleted] = useAtom(onboardingCompletedAtom);

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h1 className="text-xl font-semibold">教程与新手引导</h1>
        <p className="text-sm text-muted-foreground">
          管理 Chat 首屏引导、欢迎对话入口和轻量教程提示。
        </p>
      </section>

      <section className="rounded-xl border bg-background p-4">
        <h2 className="mb-3 text-base font-medium">引导状态</h2>
        <div className="space-y-3">
          <div className="text-sm text-muted-foreground">
            <div>已关闭引导：{onboardingDismissed ? "是" : "否"}</div>
            <div>已完成引导：{onboardingCompleted ? "是" : "否"}</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setOnboardingDismissed(false);
                setOnboardingCompleted(false);
              }}
            >
              重置新手引导
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setOnboardingCompleted((prev) => !prev);
              }}
            >
              切换“已完成”状态
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setOnboardingDismissed((prev) => !prev);
              }}
            >
              切换“已关闭”状态
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
