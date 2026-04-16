import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
export const tabsAtom = atom([]);
export const activeTabIdAtom = atomWithStorage('active-tab-id', null);
export const sidebarCollapsedAtom = atomWithStorage('sidebar-collapsed', false);
