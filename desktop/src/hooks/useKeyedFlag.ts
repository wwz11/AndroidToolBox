import { useCallback, useState } from "react";

/** SN → 是否置位。相同值不换对象，避免轮询把整页打回去渲染。 */
export function useKeyedFlag() {
  const [flags, setFlags] = useState<Record<string, boolean>>({});

  const mark = useCallback((sn: string, on: boolean) => {
    const key = sn.trim();
    if (!key) return;
    setFlags((prev) => {
      const cur = Boolean(prev[key]);
      if (cur === on) return prev;
      if (!on) {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: true };
    });
  }, []);

  return [flags, mark] as const;
}
