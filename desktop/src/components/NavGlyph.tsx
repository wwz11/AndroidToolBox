import type { ReactNode } from "react";

export type NavGlyphName =
  | "devices"
  | "emmc"
  | "monkey"
  | "serial"
  | "md5"
  | "barcode"
  | "base64"
  | "gota"
  | "about";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function NavGlyph({ name }: { name: NavGlyphName }) {
  switch (name) {
    case "devices":
      return (
        <Icon>
          <rect x="3" y="4" width="18" height="13" rx="2" />
          <path d="M12 17v3M8 20h8" />
        </Icon>
      );
    case "emmc":
      return (
        <Icon>
          <path d="M7 8.5 9 4h9v16H7V8.5z" />
          <path d="M10 4v3.5M13.5 4v3.5M17 4v3.5" />
        </Icon>
      );
    case "monkey":
      return (
        <Icon>
          <circle cx="7" cy="10" r="2.2" />
          <circle cx="17" cy="10" r="2.2" />
          <circle cx="12" cy="13.6" r="5.1" />
        </Icon>
      );
    case "serial":
      return (
        <Icon>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="m7 9 3 3-3 3M13 15h4" />
        </Icon>
      );
    case "md5":
      return (
        <Icon>
          <path d="M9 4 7 20M17 4l-2 16M5 9h15M4 15h15" />
        </Icon>
      );
    case "barcode":
      return (
        <Icon>
          <path d="M4 5v14" strokeWidth="2.25" />
          <path d="M8 5v14" />
          <path d="M11.5 5v14" strokeWidth="2.75" />
          <path d="M16 5v14" />
          <path d="M19.5 5v14" strokeWidth="2.25" />
        </Icon>
      );
    case "base64":
      return (
        <Icon>
          <path d="M9 5.5c-2.4 1.6-2.4 11.4 0 13M15 5.5c2.4 1.6 2.4 11.4 0 13" />
        </Icon>
      );
    case "gota":
      return (
        <Icon>
          <rect x="3" y="5" width="7.5" height="14" rx="1.5" />
          <rect x="13.5" y="5" width="7.5" height="14" rx="1.5" />
        </Icon>
      );
    case "about":
      return (
        <Icon>
          <path d="M4 7h16M4 12h16M4 17h16" />
          <circle cx="8" cy="7" r="1.7" fill="var(--surface)" stroke="currentColor" />
          <circle cx="15" cy="12" r="1.7" fill="var(--surface)" stroke="currentColor" />
          <circle cx="10" cy="17" r="1.7" fill="var(--surface)" stroke="currentColor" />
        </Icon>
      );
  }
}

