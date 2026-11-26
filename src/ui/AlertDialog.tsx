import { AlertTriangle, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "./Button";
import { Dialog, DialogClose } from "./Dialog";
import { Input } from "./Input";

export interface AlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** danger: destructive confirm, initial focus on Cancel (§5.7). */
  tone?: "default" | "danger" | "warning";
  /** Require typing this exact text to enable confirm (irreversible actions). */
  confirmText?: string;
  /** May return a promise: the confirm button shows loading and the dialog closes on resolve. */
  onConfirm: () => unknown;
  icon?: ReactNode;
  children?: ReactNode;
}

export function AlertDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  confirmText,
  onConfirm,
  icon,
  children,
}: AlertDialogProps) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = !!confirmText && typed !== confirmText;
  const danger = tone === "danger";
  const run = async () => {
    try {
      setBusy(true);
      await onConfirm();
      onOpenChange(false);
      setTyped("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) setTyped("");
        onOpenChange(v);
      }}
      alert
      size="sm"
      title={title}
      description={description}
      dismissible={!busy}
      icon={
        icon === undefined && tone !== "default" ? (
          <div className="emp-alert-icon" data-tone={tone}>
            {danger ? <Trash2 aria-hidden /> : <AlertTriangle aria-hidden />}
          </div>
        ) : (
          icon
        )
      }
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary" data-autofocus={danger ? "" : undefined} disabled={busy}>
              {cancelLabel}
            </Button>
          </DialogClose>
          <Button
            variant={danger ? "destructive" : "primary"}
            loading={busy}
            disabled={locked}
            data-autofocus={danger || confirmText ? undefined : ""}
            onClick={() => void run()}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children || confirmText ? (
        <div className="flex flex-col gap-3">
          {children}
          {confirmText ? (
            <Input
              label={
                <>
                  Type <span className="font-mono text-primary">{confirmText}</span> to confirm
                </>
              }
              value={typed}
              onChange={(e) => setTyped(e.currentTarget.value)}
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(e) => e.key === "Enter" && !locked && void run()}
            />
          ) : null}
        </div>
      ) : undefined}
    </Dialog>
  );
}
