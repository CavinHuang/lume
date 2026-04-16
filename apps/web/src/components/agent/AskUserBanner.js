import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { useSetAtom } from 'jotai';
import { MessageCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { agentPendingInteractiveAtom } from '@/atoms';
import { sidecarCall } from '@/lib/desktop-api';
export function AskUserBanner({ threadId, request }) {
    const setPending = useSetAtom(agentPendingInteractiveAtom);
    const [answers, setAnswers] = useState({});
    const select = (question, label) => {
        setAnswers((prev) => ({ ...prev, [question]: label }));
    };
    const submit = async () => {
        await sidecarCall('agent:submit-ask-user-question', { threadId, toolUseId: request.toolUseId, answers });
        setPending((prev) => {
            const next = { ...prev };
            if (next[threadId])
                next[threadId] = { ...next[threadId], askUserQuestion: undefined };
            return next;
        });
    };
    const allAnswered = request.questions.every((q) => answers[q.question]);
    return (_jsxs("div", { className: "animate-in slide-in-from-bottom-2 duration-200 mx-4 mb-3 rounded-xl border bg-card shadow-lg", children: [_jsxs("div", { className: "flex items-center gap-2 px-3 pt-3 pb-2", children: [_jsx(MessageCircle, { size: 14, className: "text-foreground/50" }), _jsx("span", { className: "text-[13px] font-medium text-foreground", children: "\u9700\u8981\u4F60\u7684\u8F93\u5165" })] }), _jsxs("div", { className: "px-3 pb-3 space-y-3", children: [request.questions.map((q) => (_jsxs("div", { children: [_jsx("p", { className: "text-[12px] text-foreground/70 mb-1.5", children: q.question }), _jsx("div", { className: "flex flex-wrap gap-1.5", children: q.options.map((opt) => (_jsx("button", { onClick: () => select(q.question, opt.label), className: cn('px-2.5 py-1 rounded-lg text-[12px] border transition-colors', answers[q.question] === opt.label
                                        ? 'bg-primary text-primary-foreground border-primary'
                                        : 'border-border/50 text-foreground/70 hover:bg-muted/50'), children: opt.label }, opt.label))) })] }, q.question))), _jsx("button", { onClick: submit, disabled: !allAnswered, className: "px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-[12px] font-medium hover:opacity-90 transition-opacity disabled:opacity-40", children: "\u63D0\u4EA4" })] })] }));
}
