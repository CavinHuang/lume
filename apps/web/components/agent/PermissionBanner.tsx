/**
 * PermissionBanner — Agent 权限请求内联横幅
 *
 * 内联在对话流底部，当有待处理的权限请求时显示。
 * - Enter 键快速允许
 * - risk 等级可视化（low/medium/high）
 * - 命令内容展示
 * - 支持 deny / allow_once / allow_always 三种决策
 */
import * as React from "react";
import { Check, Shield, ShieldAlert, ShieldCheck, X } from "lucide-react";
import type { AgentToolPermissionRequest, AgentToolPermissionDecision, AgentToolPermissionRiskLevel } from "@lume/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const RISK_STYLES: Record<AgentToolPermissionRiskLevel, { icon: typeof Shield; iconClass: string; borderClass: string }> = {
  low: {
    icon: ShieldCheck,
    iconClass: "text-green-500",
    borderClass: "border-green-500/20",
  },
  medium: {
    icon: Shield,
    iconClass: "text-primary",
    borderClass: "border-primary/20",
  },
  high: {
    icon: ShieldAlert,
    iconClass: "text-amber-500",
    borderClass: "border-amber-500/30",
  },
};

interface PermissionBannerProps {
  request: AgentToolPermissionRequest;
  submitting: boolean;
  error: string | null;
  onDecision: (decision: AgentToolPermissionDecision) => void;
}

export function PermissionBanner({ request, submitting, error, onDecision }: PermissionBannerProps): React.ReactElement {
  const risk = request.risk ?? "medium";
  const style = RISK_STYLES[risk] ?? RISK_STYLES.medium;
  const IconComponent = style.icon;

  // Enter 键快捷允许
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "Enter") {
        e.preventDefault();
        if (!submitting) onDecision("allow_once");
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [submitting, onDecision]);

  // 提取命令或工具输入摘要
  const commandDisplay = React.useMemo(() => {
    const cmd = request.input.command;
    if (typeof cmd === "string") return cmd;
    if (Object.keys(request.input).length > 0) {
      return JSON.stringify(request.input, null, 2);
    }
    return null;
  }, [request.input]);

  return (
    <div
      className={cn(
        "mx-4 mb-3 overflow-hidden rounded-xl border bg-card shadow-lg",
        "animate-in slide-in-from-bottom-2 duration-200",
        style.borderClass,
      )}
    >
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          <IconComponent className={cn("size-4", style.iconClass)} />
          <span className="text-sm font-medium">
            {risk === "high" ? "危险操作需要确认" : "需要确认"}
          </span>
        </div>
        <span className="font-mono text-xs text-muted-foreground">{request.toolName}</span>
      </div>

      {/* 原因描述 */}
      {request.reason && (
        <div className="px-3 pb-1 text-xs text-muted-foreground">{request.reason}</div>
      )}

      {/* 命令/操作内容 */}
      {commandDisplay && (
        <div className="px-3 pb-2">
          <pre className="max-h-[120px] overflow-y-auto overflow-x-auto whitespace-pre-wrap break-all rounded bg-background/50 px-2 py-1.5 font-mono text-xs">
            {commandDisplay}
          </pre>
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div className="mx-3 mb-2 rounded border border-destructive/40 bg-destructive/5 px-2 py-1 text-xs text-destructive">
          {error}
        </div>
      )}

      {/* 操作按钮 */}
      <div className="flex items-center justify-end gap-1.5 px-3 pb-2.5">
        <span className="mr-auto text-[10px] text-muted-foreground/40">Enter 允许一次</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onDecision("deny")}
          disabled={submitting}
          className="h-7 px-3 text-xs text-muted-foreground hover:text-destructive"
        >
          <X className="mr-1 size-3" />
          拒绝
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onDecision("allow_always")}
          disabled={submitting}
          className="h-7 px-3 text-xs"
        >
          本次会话总是允许
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={() => onDecision("allow_once")}
          disabled={submitting}
          className="h-7 px-3 text-xs"
        >
          <Check className="mr-1 size-3" />
          允许一次
        </Button>
      </div>
    </div>
  );
}
