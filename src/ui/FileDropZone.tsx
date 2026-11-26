import { UploadCloud } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { renderIcon, type IconComponent } from "./Button";

export interface FileDropZoneProps {
  /** Called with dropped files (browser mode) — desktop flows should prefer `onBrowse` → file_pick grants. */
  onFiles?: (files: File[]) => void;
  /** Click / Enter handler (desktop: invoke file_pick). */
  onBrowse?: () => void;
  title?: ReactNode;
  hint?: ReactNode;
  icon?: IconComponent | ReactNode;
  accept?: string[];
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
}

/** File drop zone (§5.11): 1.5px dashed border-strong, radius 14; accent / accent-soft while a file hovers. */
export function FileDropZone({ onFiles, onBrowse, title = "Drop a file here", hint, icon = UploadCloud, accept, disabled, className, children }: FileDropZoneProps) {
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
      <span className="emp-dropzone-icon">{renderIcon(icon)}</span>
      <span className="text-body text-primary font-medium">{title}</span>
      {hint ? <span className="text-body-sm text-tertiary">{hint}</span> : null}
      {children}
    </div>
  );
}
