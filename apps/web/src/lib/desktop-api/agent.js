import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
export const agentSend = (input) => invoke('sidecar_call', {
    method: 'agent:send-thread-message',
    params: input,
});
export const onSidecarEvent = (cb) => listen('sidecar:event', (e) => cb(e.payload.method, e.payload.params));
export const listThreads = () => invoke('sidecar_call', { method: 'agent:list-threads', params: null });
export const createThread = (workspaceId) => invoke('sidecar_call', { method: 'agent:create-thread', params: { workspaceId } });
