import { THEMES, type ThemeId } from "../../theme";

type Props = {
  value: ThemeId;
  onChange: (id: ThemeId) => void;
};

/** 关于弹窗内的换肤选择器 */
export default function ThemePicker({ value, onChange }: Props) {
  return (
    <div className="theme-picker">
      <div className="theme-picker-head">
        <div>
          <strong>界面皮肤</strong>
          <p>选择后立即生效并记住</p>
        </div>
      </div>
      <div className="theme-grid" role="listbox" aria-label="界面皮肤">
        {THEMES.map((t) => {
          const p = t.preview;
          return (
            <button
              key={t.id}
              type="button"
              role="option"
              aria-selected={value === t.id}
              className={`theme-card${value === t.id ? " active" : ""}`}
              onClick={() => onChange(t.id)}
            >
              <div
                className="theme-preview"
                style={{ background: p.bg, borderColor: p.border }}
                aria-hidden
              >
                <span
                  className="theme-preview-rail"
                  style={{ background: p.surface, borderColor: p.border }}
                />
                <span
                  className="theme-preview-panel"
                  style={{ background: p.surface, borderColor: p.border }}
                >
                  <span
                    className="theme-preview-accent"
                    style={{ background: p.accent }}
                  />
                </span>
                <span
                  className="theme-preview-term"
                  style={{ background: p.term }}
                  title="终端"
                />
              </div>
              <div className="theme-card-meta">
                <strong>{t.label}</strong>
                <span>{t.hint}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
