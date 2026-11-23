import { useCallback, useRef, useState } from "react";
import { toErrorMessage } from "../errors";

export type AsyncPhase = "idle" | "loading" | "success" | "error";

type Options = {
  /** 默认 true：并发第二次调用直接忽略 */
  ignoreIfBusy?: boolean;
};

/**
 * 把各面板里散落的 busy/try/catch/status 收成统一状态机。
 * 不改变 API 调用本身，只规范 UI 状态。
 */
export function useAsyncAction(opts: Options = {}) {
  const ignoreIfBusy = opts.ignoreIfBusy !== false;
  const [phase, setPhase] = useState<AsyncPhase>("idle");
  const [error, setError] = useState("");
  const busyRef = useRef(false);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      if (ignoreIfBusy && busyRef.current) return undefined;
      busyRef.current = true;
      setPhase("loading");
      setError("");
      try {
        const result = await fn();
        setPhase("success");
        return result;
      } catch (e) {
        const msg = toErrorMessage(e);
        setError(msg);
        setPhase("error");
        return undefined;
      } finally {
        busyRef.current = false;
      }
    },
    [ignoreIfBusy],
  );

  const reset = useCallback(() => {
    setPhase("idle");
    setError("");
  }, []);

  return {
    phase,
    error,
    busy: phase === "loading",
    run,
    reset,
  };
}
