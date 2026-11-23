import { useState } from "react";
import {
  DEFAULT_SHELL_PREFS,
  SHELL_FONT_OPTIONS,
  type ShellPrefs,
  patchShellPrefs,
  readShellPrefs,
} from "../../shellPrefs";

/** 关于/设置弹窗内：Shell / 串口终端字体等 */
export default function ShellPrefsPicker() {
  const [prefs, setPrefs] = useState<ShellPrefs>(() => readShellPrefs());

  function apply(patch: Partial<ShellPrefs>) {
    setPrefs(patchShellPrefs(patch));
  }

  return (
    <div className="shell-prefs">
      <div className="shell-prefs-head">
        <div>
          <strong>终端显示</strong>
          <p>作用于 ADB Shell 与串口终端，立即生效</p>
        </div>
      </div>

      <div className="shell-prefs-card">
        <div className="shell-prefs-grid">
          <label className="shell-prefs-field">
            <span>字体大小</span>
            <div className="shell-prefs-inline">
              <input
                type="range"
                min={10}
                max={22}
                step={1}
                value={prefs.fontSize}
                onChange={(e) => apply({ fontSize: Number(e.target.value) })}
                aria-label="终端字体大小"
              />
              <strong className="shell-prefs-value">{prefs.fontSize}px</strong>
            </div>
          </label>

          <label className="shell-prefs-field">
            <span>行高</span>
            <div className="shell-prefs-inline">
              <input
                type="range"
                min={1}
                max={1.8}
                step={0.05}
                value={prefs.lineHeight}
                onChange={(e) => apply({ lineHeight: Number(e.target.value) })}
                aria-label="终端行高"
              />
              <strong className="shell-prefs-value">
                {prefs.lineHeight.toFixed(2)}
              </strong>
            </div>
          </label>
        </div>

        <div className="shell-prefs-field">
          <span>字体</span>
          <div className="app-settings-chips" role="radiogroup" aria-label="终端字体">
            {SHELL_FONT_OPTIONS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={prefs.fontId === f.id}
                className={`app-chip${prefs.fontId === f.id ? " is-on" : ""}`}
                style={{ fontFamily: f.css }}
                onClick={() => apply({ fontId: f.id })}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="app-settings-toggles">
          <label className="app-settings-toggle">
            <div className="app-settings-toggle-copy">
              <strong>光标闪烁</strong>
              <span>块状光标是否闪烁</span>
            </div>
            <span
              className={`app-switch${prefs.cursorBlink ? " is-on" : ""}`}
              aria-hidden
            >
              <span className="app-switch-knob" />
            </span>
            <input
              type="checkbox"
              checked={prefs.cursorBlink}
              onChange={(e) => apply({ cursorBlink: e.target.checked })}
            />
          </label>
        </div>

        <code
          className="shell-prefs-sample"
          style={{
            fontFamily: SHELL_FONT_OPTIONS.find((f) => f.id === prefs.fontId)
              ?.css,
            fontSize: prefs.fontSize,
            lineHeight: prefs.lineHeight,
          }}
        >
          $ adb shell — AaBbCc 012345
        </code>

        <div className="shell-prefs-actions">
          <button
            type="button"
            className="btn ghost"
            onClick={() => apply({ ...DEFAULT_SHELL_PREFS })}
          >
            恢复默认
          </button>
        </div>
      </div>
    </div>
  );
}
