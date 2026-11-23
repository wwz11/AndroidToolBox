/** 界面换肤：通过 html[data-theme] + CSS 变量切换，localStorage 持久化。 */

export type ThemeId = "light" | "dark" | "ocean" | "graphite";

export type ThemeOption = {
  id: ThemeId;
  label: string;
  hint: string;
  /** 强调色预览 */
  swatch: string;
  /** 卡片迷你预览条（固定色值，不依赖当前主题变量） */
  preview: {
    bg: string;
    surface: string;
    accent: string;
    border: string;
    term: string;
  };
};

export const THEME_KEY = "toolbox.theme";

export const THEMES: ThemeOption[] = [
  {
    id: "light",
    label: "浅色",
    hint: "中性灰 + 青绿",
    swatch: "#0f766e",
    preview: {
      bg: "#f3f4f6",
      surface: "#ffffff",
      accent: "#0f766e",
      border: "#d8dbe2",
      term: "#ffffff",
    },
  },
  {
    id: "dark",
    label: "深色",
    hint: "炭黑 + 柔和青绿",
    swatch: "#4db6a0",
    preview: {
      bg: "#0e1014",
      surface: "#1c2129",
      accent: "#4db6a0",
      border: "#3b4452",
      term: "#1c2129",
    },
  },
  {
    id: "ocean",
    label: "海青",
    hint: "冷灰蓝 + 晴空蓝",
    swatch: "#0284c7",
    preview: {
      bg: "#eef3f7",
      surface: "#ffffff",
      accent: "#0284c7",
      border: "#c5d3e0",
      term: "#ffffff",
    },
  },
  {
    id: "graphite",
    label: "石墨",
    hint: "深灰 + 暖沙金",
    swatch: "#c4a574",
    preview: {
      bg: "#111214",
      surface: "#222328",
      accent: "#c4a574",
      border: "#464850",
      term: "#222328",
    },
  },
];

const IDS = new Set<ThemeId>(THEMES.map((t) => t.id));

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === "string" && IDS.has(v as ThemeId);
}

export function readStoredTheme(): ThemeId {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (isThemeId(v)) return v;
  } catch {
    /* ignore */
  }
  return "light";
}

export function applyTheme(id: ThemeId): void {
  const theme = isThemeId(id) ? id : "light";
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
  // 同步启动底色，减少闪白
  const bg = getComputedStyle(document.documentElement)
    .getPropertyValue("--bg")
    .trim();
  if (bg) {
    document.documentElement.style.background = bg;
    if (document.body) document.body.style.background = bg;
  }
  window.dispatchEvent(new Event("toolbox-theme-change"));
}

export function initTheme(): ThemeId {
  const id = readStoredTheme();
  applyTheme(id);
  return id;
}
