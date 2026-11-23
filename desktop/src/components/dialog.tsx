import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Modal from "./Modal";

export type ConfirmOptions = {
  title?: string;
  /** 主说明 */
  message: string;
  /** 高亮目标（如包名），等宽展示 */
  detail?: string;
  /** 底部风险提示 */
  note?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

export type AlertOptions = {
  title?: string;
  message: string;
  okLabel?: string;
};

export type PromptOptions = {
  title?: string;
  message?: string;
  defaultValue?: string;
  okLabel?: string;
  cancelLabel?: string;
  placeholder?: string;
};

type DialogApi = {
  confirm: (opts: ConfirmOptions | string) => Promise<boolean>;
  alert: (opts: AlertOptions | string) => Promise<void>;
  prompt: (opts: PromptOptions | string) => Promise<string | null>;
};

type Kind = "confirm" | "alert" | "prompt";

type Pending = {
  kind: Kind;
  title: string;
  message: string;
  detail: string;
  note: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
  defaultValue: string;
  placeholder: string;
  resolveConfirm?: (v: boolean) => void;
  resolveAlert?: () => void;
  resolvePrompt?: (v: string | null) => void;
};

const DialogContext = createContext<DialogApi | null>(null);

function normalizeConfirm(opts: ConfirmOptions | string): ConfirmOptions {
  return typeof opts === "string" ? { message: opts } : opts;
}

function normalizeAlert(opts: AlertOptions | string): AlertOptions {
  return typeof opts === "string" ? { message: opts } : opts;
}

function normalizePrompt(opts: PromptOptions | string): PromptOptions {
  return typeof opts === "string" ? { title: opts } : opts;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const close = useCallback(() => setPending(null), []);

  const api = useMemo<DialogApi>(
    () => ({
      confirm(opts) {
        const o = normalizeConfirm(opts);
        return new Promise<boolean>((resolve) => {
          setPending({
            kind: "confirm",
            title: o.title || (o.danger ? "请确认" : "确认"),
            message: o.message,
            detail: (o.detail || "").trim(),
            note: (o.note || "").trim(),
            confirmLabel: o.confirmLabel || "确定",
            cancelLabel: o.cancelLabel || "取消",
            danger: Boolean(o.danger),
            defaultValue: "",
            placeholder: "",
            resolveConfirm: resolve,
          });
        });
      },
      alert(opts) {
        const o = normalizeAlert(opts);
        return new Promise<void>((resolve) => {
          setPending({
            kind: "alert",
            title: o.title || "提示",
            message: o.message,
            detail: "",
            note: "",
            confirmLabel: o.okLabel || "知道了",
            cancelLabel: "",
            danger: false,
            defaultValue: "",
            placeholder: "",
            resolveAlert: resolve,
          });
        });
      },
      prompt(opts) {
        const o = normalizePrompt(opts);
        return new Promise<string | null>((resolve) => {
          setPromptValue(o.defaultValue ?? "");
          setPending({
            kind: "prompt",
            title: o.title || "输入",
            message: o.message || "",
            detail: "",
            note: "",
            confirmLabel: o.okLabel || "确定",
            cancelLabel: o.cancelLabel || "取消",
            danger: false,
            defaultValue: o.defaultValue ?? "",
            placeholder: o.placeholder || "",
            resolvePrompt: resolve,
          });
          requestAnimationFrame(() => inputRef.current?.focus());
        });
      },
    }),
    [],
  );

  function finishConfirm(ok: boolean) {
    pending?.resolveConfirm?.(ok);
    close();
  }

  function finishAlert() {
    pending?.resolveAlert?.();
    close();
  }

  function finishPrompt(ok: boolean) {
    pending?.resolvePrompt?.(ok ? promptValue : null);
    close();
  }

  return (
    <DialogContext.Provider value={api}>
      {children}
      {pending ? (
        <Modal
          open
          bare
          size="sm"
          zClass="modal-top"
          labelledBy="app-dialog-title"
          onClose={() => {
            if (pending.kind === "confirm") finishConfirm(false);
            else if (pending.kind === "alert") finishAlert();
            else finishPrompt(false);
          }}
          footer={
            pending.kind === "alert" ? (
              <button
                type="button"
                className="btn primary"
                autoFocus
                onClick={finishAlert}
              >
                {pending.confirmLabel}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() =>
                    pending.kind === "prompt"
                      ? finishPrompt(false)
                      : finishConfirm(false)
                  }
                >
                  {pending.cancelLabel}
                </button>
                <button
                  type="button"
                  className={`btn${pending.danger ? " danger" : " primary"}`}
                  autoFocus={pending.kind === "confirm"}
                  onClick={() =>
                    pending.kind === "prompt"
                      ? finishPrompt(true)
                      : finishConfirm(true)
                  }
                >
                  {pending.confirmLabel}
                </button>
              </>
            )
          }
        >
          <div className="dialog-prompt">
            <div className="dialog-copy">
              <h2 id="app-dialog-title">{pending.title}</h2>
              {pending.message ? (
                <p className="dialog-message">{pending.message}</p>
              ) : null}
            </div>
            {pending.detail ? (
              <div className="dialog-detail" title={pending.detail}>
                {pending.detail}
              </div>
            ) : null}
            {pending.note ? (
              <p className="dialog-note">{pending.note}</p>
            ) : null}
            {pending.kind === "prompt" ? (
              <input
                ref={inputRef}
                className="field dialog-input"
                value={promptValue}
                placeholder={pending.placeholder}
                onChange={(e) => setPromptValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") finishPrompt(true);
                }}
              />
            ) : null}
          </div>
        </Modal>
      ) : null}
    </DialogContext.Provider>
  );
}

export function useDialog(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error("useDialog 需在 DialogProvider 内使用");
  }
  return ctx;
}
