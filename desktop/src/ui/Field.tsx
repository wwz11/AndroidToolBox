import {
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  forwardRef,
} from "react";

type FieldBase = {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  controlClassName?: string;
};

type InputProps = FieldBase &
  Omit<InputHTMLAttributes<HTMLInputElement>, "className"> & { as?: "input" };

type AreaProps = FieldBase &
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className"> & {
    as: "textarea";
  };

type SelectProps = FieldBase &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, "className"> & { as: "select" };

export type FieldProps = InputProps | AreaProps | SelectProps;

function wrap(
  label: ReactNode | undefined,
  hint: ReactNode | undefined,
  error: ReactNode | undefined,
  className: string,
  control: ReactNode,
) {
  return (
    <label className={`ui-field ${className}`.trim()}>
      {label != null ? <span className="ui-field-label">{label}</span> : null}
      {control}
      {error != null ? (
        <span className="ui-field-error" role="alert">
          {error}
        </span>
      ) : hint != null ? (
        <span className="ui-field-hint">{hint}</span>
      ) : null}
    </label>
  );
}

/** 统一表单控件外壳：input / textarea / select，样式仍走现有 .field。 */
export const Field = forwardRef<
  HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  FieldProps
>(function Field(props, ref) {
  const { label, hint, error, className = "", controlClassName = "", as = "input" } =
    props;
  const fieldClass = ["field", "ui-field-control", controlClassName]
    .filter(Boolean)
    .join(" ");

  if (as === "textarea") {
    const {
      label: _l,
      hint: _h,
      error: _e,
      className: _c,
      controlClassName: _cc,
      as: _a,
      ...rest
    } = props as AreaProps;
    return wrap(
      label,
      hint,
      error,
      className,
      <textarea
        ref={ref as Ref<HTMLTextAreaElement>}
        className={fieldClass}
        aria-invalid={error ? true : undefined}
        {...rest}
      />,
    );
  }
  if (as === "select") {
    const {
      label: _l,
      hint: _h,
      error: _e,
      className: _c,
      controlClassName: _cc,
      as: _a,
      ...rest
    } = props as SelectProps;
    return wrap(
      label,
      hint,
      error,
      className,
      <select
        ref={ref as Ref<HTMLSelectElement>}
        className={fieldClass}
        aria-invalid={error ? true : undefined}
        {...rest}
      />,
    );
  }
  const {
    label: _l,
    hint: _h,
    error: _e,
    className: _c,
    controlClassName: _cc,
    as: _a,
    ...rest
  } = props as InputProps;
  return wrap(
    label,
    hint,
    error,
    className,
    <input
      ref={ref as Ref<HTMLInputElement>}
      className={fieldClass}
      aria-invalid={error ? true : undefined}
      {...rest}
    />,
  );
});
