import { useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { onSidecarEvent } from '@/lib/desktop-api';
import { agentSDKMessagesAtom, agentStreamingStatesAtom, agentRuntimeStatusAtom, agentPendingInteractiveAtom, agentSubagentRunsAtom, agentPlanStateAtom, agentThreadsAtom, agentErrorMessagesAtom, } from '@/atoms';
export function useGlobalAgentListeners() {
    const setSDKMessages = useSetAtom(agentSDKMessagesAtom);
    const setStreamingStates = useSetAtom(agentStreamingStatesAtom);
    const setRuntimeStatus = useSetAtom(agentRuntimeStatusAtom);
    const setPendingInteractive = useSetAtom(agentPendingInteractiveAtom);
    const setSubagentRuns = useSetAtom(agentSubagentRunsAtom);
    const setPlanState = useSetAtom(agentPlanStateAtom);
    const setThreads = useSetAtom(agentThreadsAtom);
    const setErrorMessages = useSetAtom(agentErrorMessagesAtom);
    useEffect(() => {
        const unlisten = onSidecarEvent((method, params) => {
            switch (method) {
                case 'agent:stream:event': {
                    const e = params;
                    setSDKMessages((prev) => ({
                        ...prev,
                        [e.threadId]: [...(prev[e.threadId] ?? []), e.message],
                    }));
                    setStreamingStates((prev) => ({ ...prev, [e.threadId]: 'streaming' }));
                    break;
                }
                case 'agent:stream:complete': {
                    const { threadId } = params;
                    setStreamingStates((prev) => ({ ...prev, [threadId]: 'idle' }));
                    break;
                }
                case 'agent:stream:error': {
                    const { threadId, error } = params;
                    setStreamingStates((prev) => ({ ...prev, [threadId]: 'errored' }));
                    if (error) {
                        setErrorMessages((prev) => ({ ...prev, [threadId]: error }));
                    }
                    break;
                }
                case 'agent:runtime-status-changed': {
                    const { status } = params;
                    setRuntimeStatus((prev) => ({ ...prev, [status.threadId]: status }));
                    break;
                }
                case 'agent:ask-user-question': {
                    const req = params;
                    setPendingInteractive((prev) => ({
                        ...prev,
                        [req.threadId]: { ...prev[req.threadId], threadId: req.threadId, askUserQuestion: req },
                    }));
                    break;
                }
                case 'agent:tool-permission-request': {
                    const req = params;
                    setPendingInteractive((prev) => ({
                        ...prev,
                        [req.threadId]: { ...prev[req.threadId], threadId: req.threadId, toolPermission: req },
                    }));
                    break;
                }
                case 'agent:subagent-completed': {
                    const e = params;
                    setSubagentRuns((prev) => {
                        const runs = prev[e.threadId] ?? [];
                        const exists = runs.findIndex((r) => r.runId === e.runId);
                        if (exists >= 0) {
                            const updated = [...runs];
                            updated[exists] = { ...updated[exists], status: e.status };
                            return { ...prev, [e.threadId]: updated };
                        }
                        return prev;
                    });
                    break;
                }
                case 'agent:plan-state-changed': {
                    const e = params;
                    setPlanState((prev) => ({ ...prev, [e.threadId]: e }));
                    break;
                }
                case 'agent:title-updated': {
                    const { threadId, title } = params;
                    setThreads((prev) => prev.map((t) => t.id === threadId ? { ...t, title } : t));
                    break;
                }
            }
        });
        return () => { unlisten.then((fn) => fn()); };
    }, [setSDKMessages, setStreamingStates, setRuntimeStatus, setPendingInteractive, setSubagentRuns, setPlanState, setThreads, setErrorMessages]);
}
