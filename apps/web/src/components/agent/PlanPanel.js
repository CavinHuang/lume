import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { agentPlanStateAtom } from '@/atoms';
import { cn } from '@/lib/utils';
import { CheckCircle, Circle, Loader2, XCircle } from 'lucide-react';
const statusIcon = {
    pending: _jsx(Circle, { size: 13, className: "text-foreground/30" }),
    in_progress: _jsx(Loader2, { size: 13, className: "animate-spin text-blue-500" }),
    completed: _jsx(CheckCircle, { size: 13, className: "text-green-500" }),
    failed: _jsx(XCircle, { size: 13, className: "text-destructive" }),
};
export function PlanPanel({ threadId }) {
    const planStates = useAtomValue(agentPlanStateAtom);
    const plan = planStates[threadId];
    const activeStepRef = useRef(null);
    // 自动滚动到当前执行步骤
    useEffect(() => {
        activeStepRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, [plan?.steps]);
    if (!plan?.steps?.length) {
        return (_jsx("div", { className: "flex-1 flex items-center justify-center text-foreground/30 text-[13px]", children: "\u6682\u65E0 Plan" }));
    }
    return (_jsxs("div", { className: "flex flex-col h-full", children: [_jsx("div", { className: "px-3 py-2.5 border-b border-border/50 text-[12px] font-medium text-foreground/60", children: "Plan \u6B65\u9AA4" }), _jsx("div", { className: "flex-1 overflow-y-auto px-3 py-2 space-y-1 scrollbar-none", children: plan.steps.map((step) => (_jsxs("div", { ref: step.status === 'in_progress' ? activeStepRef : undefined, className: cn('flex items-start gap-2 px-2 py-2 rounded-lg text-[12px]', step.status === 'in_progress' && 'bg-blue-500/5 border border-blue-500/20'), children: [_jsx("span", { className: "mt-0.5 flex-shrink-0", children: statusIcon[step.status] }), _jsx("span", { className: cn('leading-relaxed', step.status === 'completed' ? 'text-foreground/40 line-through' : 'text-foreground/70'), children: step.text })] }, step.id))) })] }));
}
