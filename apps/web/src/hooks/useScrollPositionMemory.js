import { useRef, useCallback } from 'react';
export function useScrollPositionMemory() {
    const positions = useRef({});
    const save = useCallback((id, el) => {
        if (el)
            positions.current[id] = el.scrollTop;
    }, []);
    const restore = useCallback((id, el) => {
        if (el && positions.current[id] !== undefined) {
            el.scrollTop = positions.current[id];
        }
    }, []);
    return { save, restore };
}
