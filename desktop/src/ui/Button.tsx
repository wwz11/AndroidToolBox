import {
  type ButtonHTMLAttributes,
  type ReactNode,
  forwardRef,
} from "react";

export type ButtonVariant = "default" | "primary" | "ghost" | "danger" | "danger-ghost";
export type ButtonSize = "md" | "sm";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leftIcon?: ReactNode;
};

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: "",
  primary: "primary",
  ghost: "ghost",
  danger: "danger",
  "danger-ghost": "danger-ghost",
};

/**
 * 统一按钮：兼容现有 .btn 样式，逐步替换裸 <button className="btn">。
 * 不改变业务回调，仅规范 disabled / loading / 变体。
 */
export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  {
    variant = "default",
    size = "md",
    loading = false,
    disabled,
    leftIcon,
    className = "",
    children,
    type = "button",
    ...rest
  },
  ref,
) {
  const v = VARIANT_CLASS[variant];
  const cls = [
    "btn",
    "ui-btn",
    v,
    size === "sm" ? "ui-btn-sm" : "",
    loading ? "is-loading" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      ref={ref}
      type={type}
      className={cls}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {leftIcon ? <span className="ui-btn-icon">{leftIcon}</span> : null}
      <span className="ui-btn-label">{children}</span>
    </button>
  );
});
