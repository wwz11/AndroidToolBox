import type { ReactNode } from "react";

type Props = {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
};

/** 本地工具页顶栏：标题 + 可选说明 + 右侧操作。 */
export function PageHeader({
  title,
  description,
  actions,
  className = "",
}: Props) {
  return (
    <header className={`ui-page-header ${className}`.trim()}>
      <div className="ui-page-header-copy">
        <h2 className="ui-page-header-title">{title}</h2>
        {description != null ? (
          <p className="ui-page-header-desc">{description}</p>
        ) : null}
      </div>
      {actions != null ? (
        <div className="ui-page-header-actions">{actions}</div>
      ) : null}
    </header>
  );
}
