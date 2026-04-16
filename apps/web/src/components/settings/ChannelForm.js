import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { PROVIDER_LABELS, PROVIDER_DEFAULT_URLS } from '@lume/shared';
import { fetchChannelModels } from '@/lib/desktop-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
const PROVIDERS = Object.entries(PROVIDER_LABELS);
export function ChannelForm({ onSubmit, onCancel }) {
    const [provider, setProvider] = useState('anthropic');
    const [name, setName] = useState('');
    const [apiKey, setApiKey] = useState('');
    const [baseUrl, setBaseUrl] = useState(PROVIDER_DEFAULT_URLS['anthropic']);
    const [models, setModels] = useState([]);
    const [fetching, setFetching] = useState(false);
    const [saving, setSaving] = useState(false);
    const [fetchMsg, setFetchMsg] = useState('');
    const handleProviderChange = (p) => {
        setProvider(p);
        setBaseUrl(PROVIDER_DEFAULT_URLS[p]);
        setModels([]);
        setFetchMsg('');
    };
    const handleFetchModels = async () => {
        setFetching(true);
        setFetchMsg('');
        try {
            const r = await fetchChannelModels({ provider, baseUrl, apiKey });
            if (r.success) {
                setModels(r.models);
                setFetchMsg(`获取到 ${r.models.length} 个模型`);
            }
            else {
                setFetchMsg(r.message);
            }
        }
        catch (e) {
            setFetchMsg(e?.message ?? '请求失败');
        }
        finally {
            setFetching(false);
        }
    };
    const handleSubmit = async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
            await onSubmit({ name: name || PROVIDER_LABELS[provider], provider, baseUrl, apiKey, models, enabled: true });
        }
        finally {
            setSaving(false);
        }
    };
    return (_jsxs("form", { onSubmit: handleSubmit, className: "space-y-5 max-w-lg", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-[15px] font-semibold", children: "\u6DFB\u52A0\u6E20\u9053" }), _jsx("p", { className: "text-[12px] text-muted-foreground mt-0.5", children: "\u914D\u7F6E AI \u4F9B\u5E94\u5546\u8FDE\u63A5" })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "\u4F9B\u5E94\u5546" }), _jsxs(Select, { value: provider, onValueChange: (v) => handleProviderChange(v), children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, {}) }), _jsx(SelectContent, { children: PROVIDERS.map(([id, label]) => (_jsx(SelectItem, { value: id, children: label }, id))) })] })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "\u540D\u79F0" }), _jsx(Input, { value: name, onChange: (e) => setName(e.target.value), placeholder: PROVIDER_LABELS[provider] })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Base URL" }), _jsx(Input, { value: baseUrl, onChange: (e) => setBaseUrl(e.target.value), className: "font-mono text-[12px]" })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "API Key" }), _jsx(Input, { type: "password", value: apiKey, onChange: (e) => setApiKey(e.target.value), placeholder: "sk-...", className: "font-mono text-[12px]" })] }), _jsxs("div", { className: "space-y-2", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx(Label, { children: "\u6A21\u578B" }), _jsxs(Button, { type: "button", variant: "outline", size: "sm", onClick: handleFetchModels, disabled: fetching || !apiKey, children: [fetching && _jsx(Loader2, { size: 11, className: "animate-spin mr-1" }), "\u62C9\u53D6\u6A21\u578B\u5217\u8868"] })] }), fetchMsg && _jsx("p", { className: "text-[11px] text-muted-foreground", children: fetchMsg }), models.length > 0 && (_jsx("div", { className: "rounded-lg border divide-y max-h-48 overflow-y-auto", children: models.map((m) => (_jsxs("label", { className: "flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-muted/50", children: [_jsx("input", { type: "checkbox", checked: m.enabled, onChange: (e) => setModels((prev) => prev.map((x) => x.id === m.id ? { ...x, enabled: e.target.checked } : x)) }), _jsx("span", { className: "text-[12px] font-mono truncate", children: m.id })] }, m.id))) }))] }), _jsxs("div", { className: "flex items-center gap-2 pt-2", children: [_jsxs(Button, { type: "submit", disabled: saving || !apiKey, children: [saving && _jsx(Loader2, { size: 13, className: "animate-spin mr-1" }), "\u4FDD\u5B58"] }), _jsx(Button, { type: "button", variant: "ghost", onClick: onCancel, children: "\u53D6\u6D88" })] })] }));
}
