import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
export const agentWorkspacesAtom = atom([]);
export const currentWorkspaceIdAtom = atomWithStorage('current-workspace-id', null);
