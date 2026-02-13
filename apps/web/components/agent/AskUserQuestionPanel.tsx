"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { AgentAskUserQuestionRequest } from "@lume/shared";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const ASK_USER_OTHER_OPTION = "__other__";

export interface AskUserQuestionPanelProps {
  request: AgentAskUserQuestionRequest;
  answers: Record<string, { selected: string[]; otherText: string }>;
  error: string | null;
  submitting: boolean;
  onUpdateAnswerOption: (header: string, label: string, checked: boolean, multiSelect: boolean) => void;
  onUpdateOtherText: (header: string, text: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export function AskUserQuestionPanel({
  request,
  answers,
  error,
  submitting,
  onUpdateAnswerOption,
  onUpdateOtherText,
  onSubmit,
  onCancel
}: AskUserQuestionPanelProps): React.ReactElement {
  const [activeIndex, setActiveIndex] = useState(0);
  const [visible, setVisible] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const questions = request.questions;
  const totalQuestions = questions.length;
  const currentQuestion = questions[activeIndex];
  const currentAnswer = currentQuestion ? (answers[currentQuestion.header] ?? { selected: [], otherText: "" }) : { selected: [], otherText: "" };

  // 动画入场
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 10);
    return () => clearTimeout(timer);
  }, []);

  // Tab 键切换
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab" && !event.shiftKey && !submitting) {
        event.preventDefault();
        // 切换到下一个问题
        setActiveIndex((prev) => (prev + 1) % totalQuestions);
      } else if (event.key === "Tab" && event.shiftKey && !submitting) {
        event.preventDefault();
        // 切换到上一个问题
        setActiveIndex((prev) => (prev - 1 + totalQuestions) % totalQuestions);
      } else if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [totalQuestions, submitting, onCancel]);

  // 处理选项选择
  const handleOptionSelect = useCallback((optionValue: string, checked: boolean, multiSelect: boolean) => {
    if (!currentQuestion) return;

    onUpdateAnswerOption(currentQuestion.header, optionValue, checked, multiSelect);

    // 单选且选中了选项（非取消选中）时自动切换到下一个问题
    if (!multiSelect && checked) {
      // 使用 setTimeout 确保状态更新后再切换
      setTimeout(() => {
        // 如果还有下一个未回答的问题，切换到下一个
        if (activeIndex < totalQuestions - 1) {
          setActiveIndex(activeIndex + 1);
        }
      }, 150);
    }
  }, [currentQuestion, onUpdateAnswerOption, activeIndex, totalQuestions]);

  // 检查当前问题是否已回答
  const isCurrentAnswered = currentAnswer.selected.length > 0;

  // 检查所有问题是否都已回答
  const allAnswered = questions.every((q) => {
    const ans = answers[q.header];
    return ans && ans.selected.length > 0;
  });

  // 检查是否有"其他"选项被选中但没有填写文本
  const hasEmptyOtherText = questions.some((q) => {
    const ans = answers[q.header];
    if (!ans) return false;
    if (!ans.selected.includes(ASK_USER_OTHER_OPTION)) return false;
    return !ans.otherText.trim();
  });

  if (!currentQuestion) {
    return <></>;
  }

  const hasOtherOption = currentQuestion.options.some((item) => item.label.trim() === "其他");
  const displayOptions = hasOtherOption
    ? currentQuestion.options
    : [
        ...currentQuestion.options,
        {
          label: "其他",
          description: "手动输入自定义回答"
        }
      ];

  return (
    <div
      ref={panelRef}
      className={cn(
        "absolute inset-x-0 bottom-0 z-50 transition-all duration-300 ease-out",
        visible ? "translate-y-0 opacity-100" : "translate-y-full opacity-0"
      )}
    >
      {/* 背景遮罩 */}
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-sm"
        onClick={onCancel}
      />

      {/* 面板内容 */}
      <div className="relative mx-2 mb-2 overflow-hidden rounded-t-2xl border border-border/80 bg-background shadow-2xl md:mx-4 md:mb-4">
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-foreground">需要确认问题</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {activeIndex + 1} / {totalQuestions}
            </span>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* 问题 Tab 指示器 */}
        <div className="flex items-center gap-1 border-b border-border/40 bg-muted/30 px-3 py-2">
          {questions.map((q, idx) => {
            const answer = answers[q.header];
            const answered = answer && answer.selected.length > 0;
            return (
              <button
                key={q.header}
                type="button"
                onClick={() => setActiveIndex(idx)}
                className={cn(
                  "flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-all",
                  idx === activeIndex
                    ? "bg-background text-foreground shadow-sm"
                    : answered
                    ? "text-primary/70 hover:bg-background/50"
                    : "text-muted-foreground hover:bg-background/50"
                )}
              >
                <span className="truncate">{q.header}</span>
              </button>
            );
          })}
        </div>

        {/* 当前问题内容 */}
        <div className="max-h-[40vh] overflow-y-auto px-4 py-4">
          <div className="mb-1 text-xs text-muted-foreground">{currentQuestion.header}</div>
          <div className="mb-4 text-sm font-medium text-foreground">{currentQuestion.question}</div>

          <div className="space-y-2">
            {displayOptions.map((option, optionIndex) => {
              const optionValue = option.label === "其他" ? ASK_USER_OTHER_OPTION : option.label;
              const checked = currentAnswer.selected.includes(optionValue);
              const inputType = currentQuestion.multiSelect ? "checkbox" : "radio";

              return (
                <label
                  key={`${optionValue}-${optionIndex}`}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-all",
                    checked
                      ? "border-primary/50 bg-primary/5"
                      : "border-border/70 hover:border-border hover:bg-accent/30"
                  )}
                >
                  <input
                    type={inputType}
                    checked={checked}
                    onChange={(event) => {
                      handleOptionSelect(optionValue, event.target.checked, currentQuestion.multiSelect);
                    }}
                    disabled={submitting}
                    className="mt-0.5 size-4 accent-primary"
                  />
                  <span className="flex-1">
                    <span className="block text-sm font-medium text-foreground">{option.label}</span>
                    <span className="block text-xs text-muted-foreground">{option.description}</span>
                  </span>
                </label>
              );
            })}

            {/* 其他选项的输入框 */}
            {currentAnswer.selected.includes(ASK_USER_OTHER_OPTION) ? (
              <Input
                value={currentAnswer.otherText}
                onChange={(event) => onUpdateOtherText(currentQuestion.header, event.target.value)}
                placeholder="请输入自定义回答"
                disabled={submitting}
                className="mt-2"
                autoFocus
              />
            ) : null}
          </div>
        </div>

        {/* 错误提示 */}
        {error ? (
          <div className="mx-4 mb-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        ) : null}

        {/* 底部操作栏 */}
        <div className="flex items-center justify-between border-t border-border/60 px-4 py-3">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setActiveIndex((prev) => Math.max(0, prev - 1))}
              disabled={activeIndex === 0 || submitting}
              className="gap-1"
            >
              <ChevronLeft className="size-4" />
              上一题
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setActiveIndex((prev) => Math.min(totalQuestions - 1, prev + 1))}
              disabled={activeIndex === totalQuestions - 1 || submitting}
              className="gap-1"
            >
              下一题
              <ChevronRight className="size-4" />
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onCancel}
              disabled={submitting}
            >
              取消
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={onSubmit}
              disabled={submitting || !allAnswered || hasEmptyOtherText}
            >
              {submitting ? "提交中..." : "提交回答"}
            </Button>
          </div>
        </div>

        {/* Tab 键提示 */}
        <div className="border-t border-border/40 bg-muted/20 px-4 py-1.5 text-center text-[11px] text-muted-foreground">
          按 <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">Tab</kbd> 切换问题
          <span className="mx-2">|</span>
          按 <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">Esc</kbd> 取消
        </div>
      </div>
    </div>
  );
}
