import { useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { renderIcon, type IconComponent } from "./Button";
import { Progress } from "./Progress";
import { SlabGlyph } from "./SlabGlyph";

export interface FileDropZoneProps {
  /** Called with dropped files (browser mode) — desktop flows should prefer `onBrowse` → file_pick grants. */
  onFiles?: (files: File[]) => void;
  /** Click / Enter handler (desktop: invoke file_pick). */
  onBrowse?: () => void;
  title?: ReactNode;
  hint?: ReactNode;
  /** Custom icon instead of the slab glyph. */
  icon?: IconComponent | ReactNode;
  /** 0..1 — shows a progress groove under the copy (import/parse progress). */
  progress?: number | null;
  accept?: string[];
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
}

/**
 * File drop zone (docs/DESIGN.md §6.2): a recessed well with a dashed rim and the slab glyph. On drag-over the well
 * inverts into a raised panel, the glyph lifts and its slabs separate (exploded view), the rim goes solid; on drop the
 * slabs re-stack on `release`. `progress` shows a filling groove.
 */
export function FileDropZone({ onFiles, onBrowse, title = "Drop a file here", hint, icon, progress, accept, disabled, className, children }: FileDropZoneProps) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const ok = (f: File) => !accept?.length || accept.some((ext) => f.name.toLowerCase().endsWith(ext.toLowerCase()));
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      className={cn("emp-dropzone", disabled && "opacity-45 pointer-events-none", className)}
      data-over={over ? "" : undefined}
      onClick={onBrowse}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onBrowse?.())}
      onDragEnter={(e) => {
        e.preventDefault();
        depth.current++;
        setOver(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        const files = Array.from(e.dataTransfer.files).filter(ok);
        if (files.length) onFiles?.(files);
      }}
    >
      {icon ? <span className="emp-dropzone-icon">{renderIcon(icon)}</span> : <SlabGlyph className="emp-dropzone-glyph" size={40} exploded={over} />}
      <span className="text-body text-primary font-medium">{title}</span>
      {hint ? <span className="text-body-sm text-tertiary">{hint}</span> : null}
      {progress !== undefined && progress !== null ? <Progress className="emp-dropzone-progress" value={progress} size={4} aria-label="Import progress" /> : null}
      {children}
    </div>
  );
}
