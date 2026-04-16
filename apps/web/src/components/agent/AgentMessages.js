import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useRef, useEffect, useMemo, useCallback } from 'react';
import { SDKContentBlock } from './SDKContentBlock';
import { SubagentCard } from './SubagentCard';
import { useAtomValue } from 'jotai';
import { agentSubagentRunsAtom } from '@/atoms';
import { useScrollPositionMemory } from '@/hooks/useScrollPositionMemory';
function buildSubagentToolMap(runs) {
    const map = new Map();
    for (const run of runs) {
        if (run.parentToolUseId) {
            const list = map.get(run.parentToolUseId) ?? [];
            list.push(run);
            map.set(run.parentToolUseId, list);
        }
    }
    return map;
}
function getOrphanRuns(runs, toolMap) {
    const mapped = new Set();
    for (const list of toolMap.values()) {
        for (const r of list)
            mapped.add(r.runId);
    }
    return runs.filter((r) => !mapped.has(r.runId));
}
export function AgentMessages({ threadId, sdkMessages, streaming }) {
    const containerRef = useRef(null);
    const bottomRef = useRef(null);
    const subagentRuns = useAtomValue(agentSubagentRunsAtom)[threadId] ?? [];
    const prevThreadIdRef = useRef(threadId);
    const { save, restore } = useScrollPositionMemory();
    const subagentToolMap = useMemo(() => buildSubagentToolMap(subagentRuns), [subagentRuns]);
    const orphanRuns = useMemo(() => getOrphanRuns(subagentRuns, subagentToolMap), [subagentRuns, subagentToolMap]);
    // 切换 thread 时保存/恢复滚动位置
    useEffect(() => {
        if (prevThreadIdRef.current !== threadId) {
            save(prevThreadIdRef.current, containerRef.current);
            prevThreadIdRef.current = threadId;
            // 延迟恢复，等渲染完成
            requestAnimationFrame(() => restore(threadId, containerRef.current));
        }
    }, [threadId, save, restore]);
    // 流式输出时自动滚动到底部
    const isNearBottom = useCallback(() => {
        const el = containerRef.current;
        if (!el)
            return true;
        return el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    }, []);
    useEffect(() => {
        if (streaming && isNearBottom()) {
            bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
    }, [sdkMessages.length, subagentRuns.length, streaming, isNearBottom]);
    if (sdkMessages.length === 0) {
        return (_jsx("div", { className: "flex-1 flex items-center justify-center", children: _jsxs("div", { className: "text-center space-y-1", children: [_jsx("p", { className: "text-foreground/50 text-sm font-medium", children: "Agent \u5DF2\u5C31\u7EEA" }), _jsx("p", { className: "text-foreground/30 text-xs", children: "\u8F93\u5165\u4EFB\u52A1\u5F00\u59CB" })] }) }));
    }
    const items = [];
    for (let i = 0; i < sdkMessages.length; i++) {
        const msg = sdkMessages[i];
        items.push(_jsx(SDKContentBlock, { message: msg, index: i, animate: streaming && i === sdkMessages.length - 1, allMessages: sdkMessages, isStreaming: streaming }, msg.uuid ?? `msg-${i}`));
        if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
            for (const block of msg.message.content) {
                if (block.type === 'tool_use' && block.id) {
                    const runs = subagentToolMap.get(block.id);
                    if (runs) {
                        for (const run of runs) {
                            items.push(_jsx(SubagentCard, { run: run }, `sa-${run.runId}`));
                        }
                    }
                }
            }
        }
    }
    for (const run of orphanRuns) {
        items.push(_jsx(SubagentCard, { run: run }, `sa-${run.runId}`));
    }
    return (_jsxs("div", { ref: containerRef, className: "flex-1 overflow-y-auto px-4 py-4 space-y-2 scrollbar-none", children: [items, _jsx("div", { ref: bottomRef })] }));
}
