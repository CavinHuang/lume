/**
 * AskUserBanner — Agent AskUserQuestion 内联横幅
 *
 * 替代全屏模态框（AskUserQuestionPanel），改为底部紧凑横幅：
 * - 无背景遮罩，不打断对话阅读
 * - ↑↓ 方向键选择选项
 * - 数字键 1~N 快速选择
 * - Enter 确认当前问题（多问题时翻页，最后一题提交）
 * - Tab 头部切换多问题
 * - Esc 取消
 */
import * as React from "react";
import { Send } from "lucide-react";
import type { AgentAskUserQuestionRequest, AgentAskUserQuestionQuestion } from "@lume/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ASK_USER_OTHER_OPTION } from "./agent-interactive-requests";

interface QuestionAnswer {
  selected: string[];
  otherText: string;
}

const EMPTY_ANSWER: QuestionAnswer = { selected: [], otherText: "" };

interface AskUserBannerProps {
  request: AgentAskUserQuestionRequest;
  answers: Record<string, { selected: string[]; otherText: string }>;
  submitting: boolean;
  onUpdateAnswerOption: (header: string, label: string, checked: boolean, multiSelect: boolean) => void;
  onUpdateOtherText: (header: string, text: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export function AskUserBanner({
  request,
  answers,
  submitting,
  onUpdateAnswerOption,
  onUpdateOtherText,
  onSubmit,
  onCancel,
}: AskUserBannerProps): React.ReactElement | null {
  const questions = request.questions;
  const [activeTab, setActiveTab] = React.useState(0);
  const [focusedOptIdx, setFocusedOptIdx] = React.useState(0);
  const submitRef = React.useRef<(() => void) | null>(null);

  const isLastTab = activeTab >= questions.length - 1;
  const currentQuestion = questions[activeTab];

  // 重置状态（request 变化时）
  React.useEffect(() => {
    setActiveTab(0);
    setFocusedOptIdx(0);
  }, [request.toolUseId]);

  // 切换 tab 时重置焦点，并默认选中第一个选项
  React.useEffect(() => {
    setFocusedOptIdx(0);
    const q = questions[activeTab];
    if (!q) return;
    const header = q.header;
    const existing = answers[header];
    if (!existing || existing.selected.length === 0) {
      const firstOpt = q.options[0];
      if (firstOpt) {
        onUpdateAnswerOption(header, firstOpt.label, true, q.multiSelect);
      }
    }
  }, [activeTab]);

  const goNextTab = React.useCallback(() => {
    if (!isLastTab) setActiveTab((prev) => prev + 1);
  }, [isLastTab]);

  // 键盘导航
  React.useEffect(() => {
    if (!currentQuestion) return;
    const q = currentQuestion;
    const displayOptions = buildDisplayOptions(q);
    const itemCount = displayOptions.length;

    const handleKeyDown = (e: KeyboardEvent): void => {
      const isInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;

      if (isInput) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          if (isLastTab) submitRef.current?.();
          else goNextTab();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
        return;
      }

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next =
          e.key === "ArrowDown"
            ? (focusedOptIdx + 1) % itemCount
            : (focusedOptIdx - 1 + itemCount) % itemCount;
        setFocusedOptIdx(next);
        const opt = displayOptions[next];
        if (opt) {
          const label = opt.isOther ? ASK_USER_OTHER_OPTION : opt.label;
          onUpdateAnswerOption(q.header, label, true, q.multiSelect);
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (isLastTab) submitRef.current?.();
        else goNextTab();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key >= "1" && e.key <= "9") {
        const idx = parseInt(e.key) - 1;
        const opt = displayOptions[idx];
        if (opt) {
          setFocusedOptIdx(idx);
          const label = opt.isOther ? ASK_USER_OTHER_OPTION : opt.label;
          onUpdateAnswerOption(q.header, label, true, q.multiSelect);
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [currentQuestion, focusedOptIdx, isLastTab, goNextTab, onCancel, onUpdateAnswerOption]);

  // 检查所有问题已回答
  const allAnswered = questions.every((q) => {
    const ans = answers[q.header];
    if (!ans || ans.selected.length === 0) return false;
    if (ans.selected.includes(ASK_USER_OTHER_OPTION)) return ans.otherText.trim().length > 0;
    return true;
  });

  submitRef.current = allAnswered ? onSubmit : null;

  if (!currentQuestion) return null;

  const currentAnswer: QuestionAnswer = answers[currentQuestion.header] ?? EMPTY_ANSWER;
  const displayOptions = buildDisplayOptions(currentQuestion);
  const showOtherInput = currentAnswer.selected.includes(ASK_USER_OTHER_OPTION);

  return (
    <div className="animate-in slide-in-from-bottom-2 duration-200 mx-4 mb-3 overflow-hidden rounded-xl border bg-card shadow-lg">
      {/* 头部 */}
      <div className="px-4 pt-3 pb-2">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-foreground">Agent 需要你的输入</span>
          {questions.length > 1 && (
            <span className="text-xs text-muted-foreground">
              {activeTab + 1} / {questions.length}
            </span>
          )}
        </div>

        {/* Tab 栏（多问题时显示） */}
        {questions.length > 1 && (
          <div className="flex gap-1 flex-wrap">
            {questions.map((q, idx) => {
              const isActive = idx === activeTab;
              const ans = answers[q.header];
              const hasAnswer = ans && ans.selected.length > 0;
              return (
                <button
                  key={q.header}
                  type="button"
                  onClick={() => setActiveTab(idx)}
                  className={cn(
                    "rounded-lg px-2.5 py-1 text-xs font-medium transition-all outline-none",
                    isActive
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : hasAnswer
                        ? "bg-primary/15 text-primary"
                        : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {q.header || `问题 ${idx + 1}`}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 当前问题 */}
      <div className="px-4 pb-2">
        {/* 问题文本 */}
        <div className="flex items-center gap-2 mb-2">
          {questions.length === 1 && currentQuestion.header && (
            <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary shrink-0">
              {currentQuestion.header}
            </span>
          )}
          <p className="text-sm text-foreground">{currentQuestion.question}</p>
        </div>

        {/* 选项列表（竖向） */}
        <div className="flex flex-col gap-1">
          {displayOptions.map((opt, idx) => {
            const label = opt.isOther ? ASK_USER_OTHER_OPTION : opt.label;
            const isSelected = currentAnswer.selected.includes(label);
            const isFocused = focusedOptIdx === idx;
            return (
              <button
                key={opt.label}
                type="button"
                onClick={() => {
                  setFocusedOptIdx(idx);
                  onUpdateAnswerOption(currentQuestion.header, label, !isSelected || !currentQuestion.multiSelect, currentQuestion.multiSelect);
                }}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-left transition-all outline-none",
                  isSelected
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "bg-muted/50 text-foreground/80 hover:bg-muted",
                  isFocused && "ring-2 ring-primary/50 ring-offset-1 ring-offset-card",
                )}
              >
                <span
                  className={cn(
                    "shrink-0 text-[10px] tabular-nums",
                    isSelected ? "text-primary-foreground/60" : "text-muted-foreground/50",
                  )}
                >
                  {idx + 1}
                </span>
                <span className="font-medium">{opt.label}</span>
                {opt.description && (
                  <span
                    className={cn(
                      "text-[11px] truncate",
                      isSelected ? "text-primary-foreground/70" : "text-muted-foreground",
                    )}
                  >
                    {opt.description}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* 自定义输入框 */}
        {showOtherInput && (
          <input
            type="text"
            className="mt-2 w-full rounded-lg bg-muted/40 px-3 py-2 text-xs placeholder:text-muted-foreground/40 transition-colors focus:bg-muted/60 focus:outline-none focus:ring-2 focus:ring-primary/30"
            placeholder="输入自定义回答..."
            value={currentAnswer.otherText}
            onChange={(e) => onUpdateOtherText(currentQuestion.header, e.target.value)}
            autoFocus
          />
        )}
      </div>

      {/* 底部 */}
      <div className="flex items-center justify-end gap-1.5 px-4 pb-3">
        <span className="mr-auto text-[10px] text-muted-foreground/40">
          ↑↓ 选择 · {isLastTab ? "Enter 确认" : "Enter 下一题"} · Esc 取消
        </span>
        {isLastTab ? (
          <Button
            variant="default"
            size="sm"
            onClick={onSubmit}
            disabled={submitting || !allAnswered}
            className="h-7 px-3 text-xs"
          >
            <Send className="mr-1 size-3" />
            确认
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={goNextTab}
            className="h-7 px-3 text-xs"
          >
            下一题 →
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── 辅助：构建带"其他"的选项列表 ───

interface DisplayOption {
  label: string;
  description?: string;
  isOther?: boolean;
}

function buildDisplayOptions(question: AgentAskUserQuestionQuestion): DisplayOption[] {
  const hasOther = question.options.some((o) => o.label.trim() === "其他");
  const base: DisplayOption[] = question.options.map((o) => ({
    label: o.label,
    description: o.description,
    isOther: false,
  }));
  if (!hasOther) {
    base.push({ label: "其他...", description: "手动输入自定义回答", isOther: true });
  }
  return base;
}
