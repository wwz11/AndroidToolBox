import type { ReactNode } from "react";

export type BannerTone = "info" | "error" | "warn" | "success";

type Props = {
  tone?: BannerTone;
  children: ReactNode;
  className?: string;
  role?: "status" | "alert";
};

const TONE_CLASS: Record<BannerTone, string> = {
  info: "banner-boot",
  error: "banner-err",
  warn: "ui-banner-warn",
  success: "ui-banner-success",
};

/** 页级提示条：复用现有 banner 视觉，统一 role。 */
export function StatusBanner({
  tone = "info",
  children,
  className = "",
  role,
}: Props) {
  const implicitRole = tone === "error" || tone === "warn" ? "alert" : "status";
  return (
    <div
      className={`${TONE_CLASS[tone]} ${className}`.trim()}
      role={role || implicitRole}
    >
      {children}
    </div>
  );
}
