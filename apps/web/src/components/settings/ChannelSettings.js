import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { Plus, Trash2, ChevronRight, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { listChannels, createChannel, deleteChannel } from '@/lib/desktop-api';
import { PROVIDER_LABELS } from '@lume/shared';
import { Button } from '@/components/ui/button';
import { ChannelForm } from './ChannelForm';
export function ChannelSettings() {
    const [channels, setChannels] = useState([]);
    const [selected, setSelected] = useState(null);
    const [creating, setCreating] = useState(false);
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        listChannels()
            .then((r) => setChannels(r.channels ?? []))
            .catch(console.error)
            .finally(() => setLoading(false));
    }, []);
    const handleCreate = async (input) => {
        const ch = await createChannel(input);
        setChannels((prev) => [...prev, ch]);
        setCreating(false);
        setSelected(ch);
    };
    const handleDelete = async (id) => {
        await deleteChannel(id);
        setChannels((prev) => prev.filter((c) => c.id !== id));
        if (selected?.id === id)
            setSelected(null);
    };
    if (creating) {
        return (_jsx("div", { className: "p-6", children: _jsx(ChannelForm, { onSubmit: handleCreate, onCancel: () => setCreating(false) }) }));
    }
    return (_jsxs("div", { className: "p-6 space-y-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-[15px] font-semibold", children: "\u6E20\u9053" }), _jsx("p", { className: "text-[12px] text-muted-foreground mt-0.5", children: "\u914D\u7F6E AI \u4F9B\u5E94\u5546 API \u8FDE\u63A5" })] }), _jsxs(Button, { size: "sm", onClick: () => { setCreating(true); setSelected(null); }, children: [_jsx(Plus, { size: 13 }), "\u6DFB\u52A0\u6E20\u9053"] })] }), loading ? (_jsxs("div", { className: "flex items-center gap-2 text-muted-foreground text-[13px]", children: [_jsx(Loader2, { size: 14, className: "animate-spin" }), "\u52A0\u8F7D\u4E2D..."] })) : channels.length === 0 ? (_jsx("div", { className: "rounded-xl border border-dashed p-8 text-center", children: _jsx("p", { className: "text-[13px] text-muted-foreground", children: "\u6682\u65E0\u6E20\u9053\uFF0C\u70B9\u51FB\u300C\u6DFB\u52A0\u6E20\u9053\u300D\u5F00\u59CB\u914D\u7F6E" }) })) : (_jsx("div", { className: "space-y-2", children: channels.map((ch) => (_jsxs("div", { onClick: () => setSelected(ch), className: cn('flex items-center gap-3 px-4 py-3 rounded-xl border cursor-pointer transition-colors', selected?.id === ch.id ? 'border-foreground/20 bg-muted/50' : 'hover:bg-muted/30'), children: [_jsxs("div", { className: "flex-1 min-w-0", children: [_jsx("p", { className: "text-[13px] font-medium truncate", children: ch.name }), _jsxs("p", { className: "text-[11px] text-muted-foreground mt-0.5", children: [PROVIDER_LABELS[ch.provider], " \u00B7 ", ch.models.filter(m => m.enabled).length, " \u4E2A\u6A21\u578B"] })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: cn('size-1.5 rounded-full', ch.enabled ? 'bg-green-500' : 'bg-muted-foreground/30') }), _jsx(Button, { variant: "ghost", size: "icon", className: "size-7 text-muted-foreground hover:text-destructive", onClick: (e) => { e.stopPropagation(); handleDelete(ch.id); }, children: _jsx(Trash2, { size: 13 }) }), _jsx(ChevronRight, { size: 13, className: "text-muted-foreground" })] })] }, ch.id))) }))] }));
}
