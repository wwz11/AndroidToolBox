import { useCallback, useLayoutEffect, useRef, useState } from "react";

const BOTTOM_PX = 48;

/**
 * 黑底日志窗：贴底时自动跟随新内容；上翻后锁定视口，避免整段重绘把滚动条拽跑。
 */
export function useStickyLogScroll(contentKey: unknown) {
  const ref = useRef<HTMLPreElement | null>(null);
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  const savedTopRef = useRef(0);
  followRef.current = follow;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (followRef.current) {
      el.scrollTop = el.scrollHeight;
      savedTopRef.current = el.scrollTop;
    } else {
      // React 替换文本后浏览器常重置 scrollTop，写回上翻位置
      el.scrollTop = savedTopRef.current;
    }
  }, [contentKey]);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    savedTopRef.current = el.scrollTop;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_PX;
    setFollow((prev) => (prev === atBottom ? prev : atBottom));
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    savedTopRef.current = el.scrollTop;
    followRef.current = true;
    setFollow(true);
  }, []);

  return { ref, follow, setFollow, onScroll, scrollToBottom, followRef };
}
