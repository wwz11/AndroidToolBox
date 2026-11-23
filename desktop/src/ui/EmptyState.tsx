import type { ReactNode } from "react";

type Props = {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
};

/** 列表/面板空态：统一文案层级，不改业务判断条件。 */
export function EmptyState({ title, description, action, className = "" }: Props) {
  return (
    <div className={`ui-empty ${className}`.trim()} role="status">
      <strong className="ui-empty-title">{title}</strong>
      {description != null ? (
        <span className="ui-empty-desc">{description}</span>
      ) : null}
      {action != null ? <div className="ui-empty-action">{action}</div> : null}
    </div>
  );
}
