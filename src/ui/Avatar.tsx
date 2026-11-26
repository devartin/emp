import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { hashBlockColor } from "@/lib/hash";

export type AvatarSize = 16 | 20 | 24 | 32 | 40 | 64;

export interface AvatarProps {
  name: string;
  src?: string;
  size?: AvatarSize;
  shape?: "circle" | "square";
  /** Emoji or icon instead of initials. */
  glyph?: ReactNode;
  className?: string;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = Array.from(parts[0])[0] ?? "";
  const last = parts.length > 1 ? Array.from(parts[parts.length - 1])[0] ?? "" : "";
  return (first + last).toUpperCase();
}

/** Avatar (§5.11): 16–64px; initials at 0.42× on a hashed block colour. */
export function Avatar({ name, src, size = 24, shape = "circle", glyph, className }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const c = hashBlockColor(name);
  const showInitials = !src || failed;
  return (
    <span
      className={cn("emp-avatar", className)}
      data-shape={shape === "square" ? "square" : undefined}
      role="img"
      aria-label={name}
      style={{
        ["--av" as string]: `${size}px`,
        ["--av-fg" as string]: `var(--block-${c}-text)`,
        ["--av-bg" as string]: `var(--block-${c}-bg)`,
      }}
    >
      {showInitials ? (glyph ?? (size <= 16 ? initials(name).slice(0, 1) : initials(name))) : <img src={src} alt="" onError={() => setFailed(true)} draggable={false} />}
    </span>
  );
}

export function AvatarStack({ children, size = 24 }: { children: ReactNode; size?: AvatarSize }) {
  return (
    <span className="emp-avatar-stack" style={{ ["--av" as string]: `${size}px` }}>
      {children}
    </span>
  );
}
