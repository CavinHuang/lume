import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * McpSettings - MCP 服务器管理
 *
 * 管理 MCP 服务器配置（增删改启停）
 */
import * as React from 'react';
import { Plus, Plug, Pencil, Trash2, Loader2, ArrowLeft, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { sidecarCall } from '@/lib/desktop-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
const TRANSPORT_OPTIONS = [
    { value: 'stdio', label: 'stdio（命令行）' },
    { value: 'http', label: 'HTTP（Streamable HTTP）' },
    { value: 'sse', label: 'SSE（Server-Sent Events）' },
];
function parseKeyValueText(text, separator) {
    const result = {};
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        const idx = trimmed.indexOf(separator);
        if (idx <= 0)
            continue;
        result[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    }
    return result;
}
function serializeKeyValueText(record, separator) {
    if (!record)
        return '';
    return Object.entries(record)
        .map(([k, v]) => `${k}${separator}${separator === ':' ? ' ' : ''}${v}`)
        .join('\n');
}
export function McpSettings() {
    const [config, setConfig] = React.useState({ servers: {} });
    const [loading, setLoading] = React.useState(true);
    const [viewMode, setViewMode] = React.useState('list');
    const [editingServer, setEditingServer] = React.useState(null);
    const loadConfig = React.useCallback(async () => {
        try {
            const result = await sidecarCall('system:get-mcp-config', {});
            setConfig(result ?? { servers: {} });
        }
        catch (error) {
            console.error('[MCP 设置] 加载失败:', error);
        }
        finally {
            setLoading(false);
        }
    }, []);
    React.useEffect(() => { loadConfig(); }, [loadConfig]);
    const handleDelete = async (name) => {
        if (!confirm(`确定删除 MCP 服务器「${name}」？`))
            return;
        try {
            const newServers = { ...config.servers };
            delete newServers[name];
            const newConfig = { servers: newServers };
            await sidecarCall('system:save-mcp-config', newConfig);
            setConfig(newConfig);
        }
        catch (error) {
            console.error('[MCP 设置] 删除失败:', error);
        }
    };
    const handleToggle = async (name) => {
        try {
            const entry = config.servers[name];
            if (!entry)
                return;
            const newConfig = {
                servers: {
                    ...config.servers,
                    [name]: { ...entry, enabled: !entry.enabled },
                },
            };
            await sidecarCall('system:save-mcp-config', newConfig);
            setConfig(newConfig);
        }
        catch (error) {
            console.error('[MCP 设置] 切换状态失败:', error);
        }
    };
    const handleFormSaved = () => {
        setViewMode('list');
        setEditingServer(null);
        loadConfig();
    };
    if (viewMode === 'create' || viewMode === 'edit') {
        return (_jsx("div", { className: "p-6", children: _jsx(McpServerForm, { server: editingServer, onSaved: handleFormSaved, onCancel: () => { setViewMode('list'); setEditingServer(null); } }) }));
    }
    const serverEntries = Object.entries(config.servers ?? {});
    return (_jsxs("div", { className: "p-6 space-y-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-[15px] font-semibold", children: "MCP \u670D\u52A1\u5668" }), _jsx("p", { className: "text-[12px] text-muted-foreground mt-0.5", children: "\u7BA1\u7406 Model Context Protocol \u670D\u52A1\u5668" })] }), _jsxs(Button, { size: "sm", onClick: () => setViewMode('create'), children: [_jsx(Plus, { size: 13 }), "\u6DFB\u52A0\u670D\u52A1\u5668"] })] }), loading ? (_jsxs("div", { className: "flex items-center gap-2 text-muted-foreground text-[13px]", children: [_jsx(Loader2, { size: 14, className: "animate-spin" }), "\u52A0\u8F7D\u4E2D..."] })) : serverEntries.length === 0 ? (_jsxs("div", { className: "rounded-xl border border-dashed p-8 text-center", children: [_jsx(Plug, { size: 24, className: "mx-auto text-muted-foreground/40 mb-2" }), _jsx("p", { className: "text-[13px] text-muted-foreground", children: "\u6682\u65E0 MCP \u670D\u52A1\u5668" }), _jsx("p", { className: "text-[11px] text-muted-foreground/60 mt-1", children: "\u70B9\u51FB\u300C\u6DFB\u52A0\u670D\u52A1\u5668\u300D\u5F00\u59CB\u914D\u7F6E" })] })) : (_jsx("div", { className: "space-y-2", children: serverEntries.map(([name, entry]) => (_jsxs("div", { className: "flex items-center gap-3 px-4 py-3 rounded-xl border hover:bg-muted/30 transition-colors group", children: [_jsx(Plug, { size: 16, className: "text-blue-500 shrink-0" }), _jsxs("div", { className: "flex-1 min-w-0", children: [_jsx("p", { className: "text-[13px] font-medium truncate", children: name }), _jsx("p", { className: "text-[11px] text-muted-foreground mt-0.5 truncate", children: entry.type === 'stdio' ? entry.command : entry.url })] }), _jsx("span", { className: "text-[11px] px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground font-medium", children: entry.type }), _jsx("button", { onClick: () => { setEditingServer({ name, entry }); setViewMode('edit'); }, className: "p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors opacity-0 group-hover:opacity-100", children: _jsx(Pencil, { size: 13 }) }), _jsx("button", { onClick: () => handleDelete(name), className: "p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100", children: _jsx(Trash2, { size: 13 }) }), _jsx(Switch, { checked: entry.enabled, onCheckedChange: () => handleToggle(name) })] }, name))) }))] }));
}
// ===== MCP 服务器表单 =====
function McpServerForm({ server, onSaved, onCancel, }) {
    const isEdit = server !== null;
    const [name, setName] = React.useState(server?.name ?? '');
    const [transportType, setTransportType] = React.useState(server?.entry.type ?? 'stdio');
    const [enabled, setEnabled] = React.useState(server?.entry.enabled ?? false);
    const [command, setCommand] = React.useState(server?.entry.command ?? '');
    const [argsText, setArgsText] = React.useState(server?.entry.args?.join(', ') ?? '');
    const [envText, setEnvText] = React.useState(serializeKeyValueText(server?.entry.env, '='));
    const [url, setUrl] = React.useState(server?.entry.url ?? '');
    const [headersText, setHeadersText] = React.useState(serializeKeyValueText(server?.entry.headers, ':'));
    const [saving, setSaving] = React.useState(false);
    const [testing, setTesting] = React.useState(false);
    const [testResult, setTestResult] = React.useState(null);
    const buildEntry = () => {
        const base = { type: transportType, enabled };
        if (transportType === 'stdio') {
            base.command = command.trim();
            const args = argsText.split(',').map((s) => s.trim()).filter(Boolean);
            if (args.length > 0)
                base.args = args;
            const env = parseKeyValueText(envText, '=');
            if (Object.keys(env).length > 0)
                base.env = env;
        }
        else {
            base.url = url.trim();
            const headers = parseKeyValueText(headersText, ':');
            if (Object.keys(headers).length > 0)
                base.headers = headers;
        }
        return base;
    };
    const canSubmit = () => {
        if (!name.trim())
            return false;
        if (transportType === 'stdio' && !command.trim())
            return false;
        if (transportType !== 'stdio' && !url.trim())
            return false;
        return true;
    };
    const handleTest = async () => {
        setTesting(true);
        setTestResult(null);
        try {
            const entry = buildEntry();
            const result = await sidecarCall('system:test-mcp-server', { name: name.trim(), entry });
            setTestResult(result);
        }
        catch (error) {
            setTestResult({ success: false, message: error instanceof Error ? error.message : '测试失败' });
        }
        finally {
            setTesting(false);
        }
    };
    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!canSubmit())
            return;
        setSaving(true);
        try {
            const currentConfig = await sidecarCall('system:get-mcp-config', {});
            const newConfig = {
                servers: { ...(currentConfig?.servers ?? {}), [name.trim()]: buildEntry() },
            };
            await sidecarCall('system:save-mcp-config', newConfig);
            onSaved();
        }
        catch (error) {
            console.error('[MCP 表单] 保存失败:', error);
        }
        finally {
            setSaving(false);
        }
    };
    return (_jsxs("form", { onSubmit: handleSubmit, className: "space-y-5", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(Button, { variant: "ghost", size: "icon", className: "h-8 w-8", type: "button", onClick: onCancel, children: _jsx(ArrowLeft, { size: 16 }) }), _jsx("h3", { className: "text-[15px] font-semibold flex-1", children: isEdit ? '编辑 MCP 服务器' : '添加 MCP 服务器' }), _jsx(Button, { variant: "ghost", size: "sm", type: "button", onClick: onCancel, children: "\u53D6\u6D88" }), _jsxs(Button, { size: "sm", type: "submit", disabled: saving || !canSubmit(), children: [saving && _jsx(Loader2, { size: 13, className: "animate-spin" }), isEdit ? '保存' : '创建'] })] }), _jsxs("div", { className: "space-y-4", children: [_jsx(FormField, { label: "\u670D\u52A1\u5668\u540D\u79F0", children: _jsx(Input, { value: name, onChange: (e) => setName(e.target.value), placeholder: "\u4F8B\u5982: github-mcp", disabled: isEdit, className: "h-8 text-[13px]" }) }), _jsx(FormField, { label: "\u4F20\u8F93\u7C7B\u578B", children: _jsxs(Select, { value: transportType, onValueChange: (v) => setTransportType(v), children: [_jsx(SelectTrigger, { className: "h-8 text-[13px]", children: _jsx(SelectValue, {}) }), _jsx(SelectContent, { children: TRANSPORT_OPTIONS.map((opt) => (_jsx(SelectItem, { value: opt.value, children: opt.label }, opt.value))) })] }) }), transportType === 'stdio' ? (_jsxs(_Fragment, { children: [_jsx(FormField, { label: "\u547D\u4EE4", children: _jsx(Input, { value: command, onChange: (e) => setCommand(e.target.value), placeholder: "\u4F8B\u5982: npx", className: "h-8 text-[13px]" }) }), _jsx(FormField, { label: "\u53C2\u6570", desc: "\u591A\u4E2A\u53C2\u6570\u7528\u9017\u53F7\u5206\u9694", children: _jsx(Input, { value: argsText, onChange: (e) => setArgsText(e.target.value), placeholder: "-y, @modelcontextprotocol/server-github", className: "h-8 text-[13px]" }) }), _jsx(FormField, { label: "\u73AF\u5883\u53D8\u91CF", desc: "\u6BCF\u884C\u4E00\u4E2A\uFF0C\u683C\u5F0F: KEY=VALUE", children: _jsx(Textarea, { value: envText, onChange: (e) => setEnvText(e.target.value), placeholder: "GITHUB_TOKEN=ghp_xxx\nDEBUG=true", rows: 3, className: "text-[13px] font-mono resize-y" }) })] })) : (_jsxs(_Fragment, { children: [_jsx(FormField, { label: "URL", children: _jsx(Input, { value: url, onChange: (e) => setUrl(e.target.value), placeholder: "http://localhost:3000/mcp", className: "h-8 text-[13px]" }) }), _jsx(FormField, { label: "\u8BF7\u6C42\u5934", desc: "\u6BCF\u884C\u4E00\u4E2A\uFF0C\u683C\u5F0F: Key: Value", children: _jsx(Textarea, { value: headersText, onChange: (e) => setHeadersText(e.target.value), placeholder: "Authorization: Bearer xxx", rows: 3, className: "text-[13px] font-mono resize-y" }) })] })), _jsx(Separator, {}), _jsxs("div", { className: "space-y-3", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx(Label, { className: "text-[13px]", children: "\u8FDE\u63A5\u6D4B\u8BD5" }), _jsx("p", { className: "text-[11px] text-muted-foreground mt-0.5", children: "\u9A8C\u8BC1\u914D\u7F6E\u662F\u5426\u6B63\u786E" })] }), _jsxs(Button, { type: "button", variant: "outline", size: "sm", onClick: handleTest, disabled: testing || !canSubmit(), children: [testing && _jsx(Loader2, { size: 13, className: "animate-spin" }), testing ? '测试中...' : '测试连接'] })] }), testResult && (_jsxs("div", { className: cn('flex items-start gap-2 px-3 py-2 rounded-lg text-[12px]', testResult.success ? 'bg-green-500/10 text-green-700 dark:text-green-400' : 'bg-red-500/10 text-red-700 dark:text-red-400'), children: [testResult.success ? _jsx(CheckCircle2, { size: 14, className: "mt-0.5 shrink-0" }) : _jsx(XCircle, { size: 14, className: "mt-0.5 shrink-0" }), _jsxs("div", { children: [_jsx("div", { className: "font-medium", children: testResult.success ? '测试成功' : '测试失败' }), _jsx("div", { className: "text-[11px] mt-0.5 opacity-90", children: testResult.message })] })] })), !testResult && !testing && (_jsxs("div", { className: "flex items-start gap-2 px-3 py-2 rounded-lg text-[12px] bg-amber-500/10 text-amber-700 dark:text-amber-400", children: [_jsx(AlertCircle, { size: 14, className: "mt-0.5 shrink-0" }), _jsx("div", { className: "text-[11px]", children: "\u5EFA\u8BAE\u5148\u6D4B\u8BD5\u8FDE\u63A5\u518D\u542F\u7528" })] }))] }), _jsxs("div", { className: "flex items-center justify-between px-1", children: [_jsxs("div", { children: [_jsx(Label, { className: "text-[13px]", children: "\u542F\u7528\u6B64\u670D\u52A1\u5668" }), _jsx("p", { className: "text-[11px] text-muted-foreground mt-0.5", children: "\u5F00\u542F\u540E\u5728 Agent \u4F1A\u8BDD\u4E2D\u52A0\u8F7D" })] }), _jsx(Switch, { checked: enabled, onCheckedChange: setEnabled })] })] })] }));
}
function FormField({ label, desc, children }) {
    return (_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { className: "text-[13px]", children: label }), desc && _jsx("p", { className: "text-[11px] text-muted-foreground", children: desc }), children] }));
}
