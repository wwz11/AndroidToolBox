import type { ReactNode } from "react";

type Props = {
  /** 左侧主操作区（约定：整条工具栏最多一个 primary） */
  start?: ReactNode;
  /** 右侧状态 / 次要操作 */
  end?: ReactNode;
  wrap?: boolean;
  className?: string;
  children?: ReactNode;
};

/**
 * 工具栏布局：start | end。
 * 若只传 children，则等同于旧版 .tool-bar 单行内容。
 */
export function Toolbar({
  start,
  end,
  wrap = true,
  className = "",
  children,
}: Props) {
  const cls = [
    "tool-bar",
    "ui-toolbar",
    wrap ? "wrap" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  if (children != null && start == null && end == null) {
    return <div className={cls}>{children}</div>;
  }

  return (
    <div className={cls}>
      {start != null ? <div className="ui-toolbar-start">{start}</div> : null}
      {end != null ? <div className="ui-toolbar-end">{end}</div> : null}
    </div>
  );
}
