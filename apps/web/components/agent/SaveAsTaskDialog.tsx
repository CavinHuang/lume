import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface SaveAsTaskDialogData {
  prompt: string;
  defaultName: string;
}

interface SaveAsTaskDialogProps {
  /** null 时关闭对话框 */
  data: SaveAsTaskDialogData | null;
  onClose: () => void;
  onConfirm: (name: string, cronExpr: string) => void;
}

export function SaveAsTaskDialog({ data, onClose, onConfirm }: SaveAsTaskDialogProps): React.ReactElement {
  const [nameInput, setNameInput] = useState("");
  const [cronInput, setCronInput] = useState("30 8 * * 1-5");

  useEffect(() => {
    if (data) {
      setNameInput(data.defaultName);
      setCronInput("30 8 * * 1-5");
    }
  }, [data]);

  const canSubmit = nameInput.trim().length > 0 && cronInput.trim().length > 0;

  const handleSubmit = (): void => {
    if (!canSubmit) return;
    onConfirm(nameInput.trim(), cronInput.trim());
  };

  return (
    <Dialog open={data !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>保存为自动化任务</DialogTitle>
          <DialogDescription>为此消息创建定时自动化任务</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="task-name" className="text-sm font-medium">
              任务名称
            </label>
            <input
              id="task-name"
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="task-cron" className="text-sm font-medium">
              Cron 表达式
            </label>
            <input
              id="task-cron"
              type="text"
              value={cronInput}
              onChange={(e) => setCronInput(e.target.value)}
              placeholder="30 8 * * 1-5"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
            />
            <p className="text-xs text-muted-foreground">
              示例：「30 8 * * 1-5」= 工作日每天 8:30 执行
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
          <Button type="button" disabled={!canSubmit} onClick={handleSubmit}>
            保存任务
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
