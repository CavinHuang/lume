import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { AppShell } from '@/components/app-shell/AppShell';
import { useGlobalAgentListeners } from '@/hooks/useGlobalAgentListeners';
import { healthcheck } from '@/lib/desktop-api';
import { Provider } from 'jotai';
import { useEffect, useState } from 'react';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
function AppInner() {
    useGlobalAgentListeners();
    return _jsx(AppShell, {});
}
export function App() {
    const [ready, setReady] = useState(false);
    const [error, setError] = useState(null);
    useEffect(() => {
        healthcheck()
            .then(() => setReady(true))
            .catch(() => setError('无法连接到后端，请检查环境配置后重启应用。'));
    }, []);
    if (error) {
        return (_jsx("div", { className: "h-screen flex items-center justify-center bg-background", children: _jsx("p", { className: "text-destructive font-medium", children: error }) }));
    }
    if (!ready)
        return null;
    return (_jsx(Provider, { children: _jsxs(TooltipProvider, { children: [_jsx(AppInner, {}), _jsx(Toaster, { position: "bottom-right" })] }) }));
}
