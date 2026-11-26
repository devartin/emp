/** file_import (§16): import files (CSV / OFX / QFX / QIF via file grants), start blank, or use sample data. */
import { FileText, X } from "lucide-react";
import { useState } from "react";
import { api, errorMessage } from "@/backend";
import type { FileGrant } from "@/backend/types";
import { formatBytes } from "@/lib/format";
import { ChoiceCard } from "@/ui/ChoiceCard";
import { FileDropZone } from "@/ui/FileDropZone";
import { IconButton } from "@/ui/IconButton";
import { iconByName } from "../identity";
import { isObj, type StepProps } from "./types";

export function FileImport({ step, value, onChange }: StepProps) {
  const v = isObj(value) ? value : isObj(step.default) ? step.default : { source: "blank" };
  const source = String(v.source ?? "blank");
  const grants = (Array.isArray(v.grants) ? v.grants : []) as FileGrant[];
  const [error, setError] = useState<string | null>(null);
  const browse = async () => {
    setError(null);
    try {
      const picked = await api.file.pick({ purpose: "import", filters: [{ name: "Bank files", extensions: ["csv", "ofx", "qfx", "qif"] }], multiple: true });
      if (picked.length) onChange({ ...v, source: "import", grants: [...grants, ...picked] });
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const options = step.options ?? [
    { value: "import", label: "Import files", icon: "upload" },
    { value: "blank", label: "Start blank", icon: "file" },
    { value: "sample", label: "Use sample data", icon: "flask-conical" },
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={step.title}>
        {options.map((o) => (
          <ChoiceCard key={o.value} className="la-choice la-choice-mini" selected={source === o.value} onSelect={() => onChange({ ...v, source: o.value })} title={o.label} description={o.description} icon={iconByName(o.icon)} />
        ))}
      </div>
      {source === "import" ? (
        <div className="flex flex-col gap-2">
          <FileDropZone onBrowse={browse} title="Choose bank files" hint="CSV, OFX, QFX or QIF. You map columns after setup." accept={[".csv", ".ofx", ".qfx", ".qif"]} />
          {grants.map((g) => (
            <div key={g.grantId} className="la-file well" data-static="">
              <FileText size={14} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{g.displayName}</span>
              <span className="text-caption text-tertiary tabular">{formatBytes(g.size)}</span>
              <IconButton size="xs" icon={X} label="Remove file" onClick={() => onChange({ ...v, grants: grants.filter((x) => x.grantId !== g.grantId) })} />
            </div>
          ))}
          {error ? <p className="text-caption text-loss-text">{error}</p> : null}
        </div>
      ) : source === "sample" ? (
        <p className="la-hint">Six months of realistic, clearly tagged sample transactions. Remove them any time from the app menu.</p>
      ) : null}
    </div>
  );
}
