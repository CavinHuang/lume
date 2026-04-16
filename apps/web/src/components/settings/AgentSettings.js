import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * AgentSettings - Agent 设置页
 *
 * 包含：
 * 1. Agent 高级设置（思考模式、推理深度、预算限制、最大轮次）
 * 2. 工具策略配置
 */
import * as React from 'react';
import { ChevronDown, ChevronRight, Cpu } from 'lucide-react';
import { cn } from '@/lib/utils';
import { sidecarCall } from '@/lib/desktop-api';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
/** 思考模式选项 */
const THINKING_OPTIONS = [
    { value: 'default', label: '默认' },
    { value: 'adaptive', label: '自适应' },
    { value: 'disabled', label: '关闭' },
];
/** 推理深度选项 */
const EFFORT_OPTIONS = [
    { value: 'default', label: '默认' },
    { value: 'low', label: '低' },
    { value: 'medium', label: '中' },
    { value: 'high', label: '高' },
    { value: 'max', label: '最大' },
];
/** 权限模式选项 */
const PERMISSION_OPTIONS = [
    { value: 'default', label: '默认', desc: '每次确认高风险操作' },
    { value: 'acceptEdits', label: '允许编辑', desc: '自动接受文件编辑，确认其他操作' },
    { value: 'bypassPermissions', label: '全部允许', desc: '跳过所有权限确认（谨慎使用）' },
    { value: 'plan', label: 'Plan 模式', desc: '先规划再执行，每步确认' },
];
export function AgentSettings() {
    const [thinking, setThinking] = React.useState('default');
    const [effort, setEffort] = React.useState('default');
    const [budgetStr, setBudgetStr] = React.useState('');
    const [turnsStr, setTurnsStr] = React.useState('');
    const [permissionMode, setPermissionMode] = React.useState('default');
    const [advancedOpen, setAdvancedOpen] = React.useState(false);
    const [loading, setLoading] = React.useState(true);
    // 加载当前配置
    React.useEffect(() => {
        sidecarCall('system:get-config', {})
            .then((config) => {
            const agent = config?.agent;
            if (agent) {
                if (agent.thinking)
                    setThinking(String(agent.thinking));
                if (agent.effort)
                    setEffort(String(agent.effort));
                if (agent.maxBudgetUsd != null)
                    setBudgetStr(String(agent.maxBudgetUsd));
                if (agent.maxTurns != null)
                    setTurnsStr(String(agent.maxTurns));
            }
            const permissions = config?.permissions;
            if (permissions?.mode)
                setPermissionMode(String(permissions.mode));
        })
            .catch(console.error)
            .finally(() => setLoading(false));
    }, []);
    const updateConfig = (path, value) => {
        sidecarCall('system:update-config', { path, value }).catch(console.error);
    };
    const handleThinkingChange = (value) => {
        if (!value)
            return;
        setThinking(value);
        updateConfig('agent.thinking', value === 'default' ? null : value);
    };
    const handleEffortChange = (value) => {
        if (!value)
            return;
        setEffort(value);
        updateConfig('agent.effort', value === 'default' ? null : value);
    };
    const handleBudgetBlur = () => {
        const num = parseFloat(budgetStr);
        const value = !isNaN(num) && num > 0 ? num : null;
        updateConfig('agent.maxBudgetUsd', value);
    };
    const handleTurnsBlur = () => {
        const num = parseInt(turnsStr, 10);
        const value = !isNaN(num) && num > 0 ? num : null;
        updateConfig('agent.maxTurns', value);
    };
    const handlePermissionChange = (value) => {
        setPermissionMode(value);
        updateConfig('permissions.mode', value === 'default' ? null : value);
    };
    if (loading) {
        return (_jsx("div", { className: "p-8 text-[13px] text-muted-foreground", children: "\u52A0\u8F7D\u4E2D..." }));
    }
    return (_jsxs("div", { className: "p-6 space-y-6", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-[15px] font-semibold", children: "Agent \u8BBE\u7F6E" }), _jsx("p", { className: "text-[12px] text-muted-foreground mt-0.5", children: "\u914D\u7F6E Agent \u8FD0\u884C\u884C\u4E3A" })] }), _jsx(SettingsBlock, { title: "\u6743\u9650\u6A21\u5F0F", desc: "\u63A7\u5236 Agent \u6267\u884C\u5DE5\u5177\u65F6\u7684\u6743\u9650\u786E\u8BA4\u7B56\u7565", children: _jsx("div", { className: "space-y-2", children: PERMISSION_OPTIONS.map((opt) => (_jsxs("label", { className: cn('flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors border', permissionMode === opt.value
                            ? 'border-primary/30 bg-primary/5'
                            : 'border-transparent hover:bg-muted/30'), children: [_jsx("input", { type: "radio", name: "permission", value: opt.value, checked: permissionMode === opt.value, onChange: () => handlePermissionChange(opt.value), className: "accent-primary" }), _jsxs("div", { children: [_jsx("div", { className: "text-[13px] font-medium", children: opt.label }), _jsx("div", { className: "text-[11px] text-muted-foreground", children: opt.desc })] })] }, opt.value))) }) }), _jsx(Separator, {}), _jsxs("div", { children: [_jsxs("button", { onClick: () => setAdvancedOpen(!advancedOpen), className: "flex items-center gap-2 text-[13px] font-medium text-foreground/80 hover:text-foreground transition-colors", children: [advancedOpen ? _jsx(ChevronDown, { size: 14 }) : _jsx(ChevronRight, { size: 14 }), _jsx(Cpu, { size: 14 }), "\u9AD8\u7EA7\u8BBE\u7F6E"] }), advancedOpen && (_jsxs("div", { className: "mt-4 space-y-5 pl-1", children: [_jsx(SettingsBlock, { title: "\u601D\u8003\u6A21\u5F0F", desc: "\u81EA\u9002\u5E94\u6A21\u5F0F\u4E0B Agent \u4F1A\u6839\u636E\u4EFB\u52A1\u590D\u6742\u5EA6\u81EA\u52A8\u51B3\u5B9A\u662F\u5426\u542F\u7528\u6DF1\u5EA6\u601D\u8003", children: _jsxs(Select, { value: thinking, onValueChange: handleThinkingChange, children: [_jsx(SelectTrigger, { className: "w-40 h-8 text-[13px]", children: _jsx(SelectValue, {}) }), _jsx(SelectContent, { children: THINKING_OPTIONS.map((opt) => (_jsx(SelectItem, { value: opt.value, children: opt.label }, opt.value))) })] }) }), _jsx(SettingsBlock, { title: "\u63A8\u7406\u6DF1\u5EA6", desc: "\u63A7\u5236 Agent \u5728\u6BCF\u6B21\u56DE\u590D\u4E2D\u6295\u5165\u7684\u63A8\u7406\u8BA1\u7B97\u91CF", children: _jsxs(Select, { value: effort, onValueChange: handleEffortChange, children: [_jsx(SelectTrigger, { className: "w-40 h-8 text-[13px]", children: _jsx(SelectValue, {}) }), _jsx(SelectContent, { children: EFFORT_OPTIONS.map((opt) => (_jsx(SelectItem, { value: opt.value, children: opt.label }, opt.value))) })] }) }), _jsx(SettingsBlock, { title: "\u9884\u7B97\u9650\u5236\uFF08\u7F8E\u5143/\u6B21\uFF09", desc: "\u5355\u6B21 Agent \u4F1A\u8BDD\u7684\u6700\u5927\u82B1\u8D39\uFF0C\u7559\u7A7A\u5219\u4E0D\u9650\u5236", children: _jsx(Input, { type: "number", value: budgetStr, onChange: (e) => setBudgetStr(e.target.value), onBlur: handleBudgetBlur, placeholder: "\u4F8B\u5982: 1.0", className: "w-40 h-8 text-[13px]" }) }), _jsx(SettingsBlock, { title: "\u6700\u5927\u8F6E\u6B21", desc: "\u5355\u6B21 Agent \u4F1A\u8BDD\u7684\u6700\u5927\u4EA4\u4E92\u8F6E\u6B21\uFF0C\u7559\u7A7A\u5219\u4F7F\u7528\u9ED8\u8BA4\u503C", children: _jsx(Input, { type: "number", value: turnsStr, onChange: (e) => setTurnsStr(e.target.value), onBlur: handleTurnsBlur, placeholder: "\u4F8B\u5982: 30", className: "w-40 h-8 text-[13px]" }) })] }))] })] }));
}
function SettingsBlock({ title, desc, children }) {
    return (_jsxs("div", { className: "space-y-2", children: [_jsxs("div", { children: [_jsx(Label, { className: "text-[13px] font-medium", children: title }), desc && _jsx("p", { className: "text-[11px] text-muted-foreground mt-0.5", children: desc })] }), children] }));
}
