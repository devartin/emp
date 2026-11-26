/**
 * Home's one capture field: "Add a task, note or expense…". The same prefix grammar as ⌘K (search/capture.ts), with
 * the parse previewed under the field before Enter. Tab cycles the account of a money capture.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Id } from "@/backend/types";
import { cn } from "@/lib/cn";
import { useWorkspace } from "@/stores/workspace";
import { Kbd } from "@/ui/Kbd";
import { captureAccount, describeCapture, loadMoneyTarget, parseCapture, type MoneyTarget } from "@/features/search/capture";
import { runCapture } from "@/features/search/runCapture";

export function CaptureField({ autoFocus }: { autoFocus: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const lifeOs = useWorkspace((s) => s.lifeapps.some((a) => a.appId === "life-os" && !a.detached));
  const hasMoney = useWorkspace((s) => s.lifeapps.some((a) => a.appId === "money-hq" && !a.detached));
  const parsed = useMemo(() => (text.trim() ? parseCapture(text) : null), [text]);
  const [target, setTarget] = useState<MoneyTarget | null>(null);
  const [account, setAccount] = useState<{ id: Id; name: string } | null>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  // Money captures preview the account they land in; load it the first time one is typed.
  const wantsMoney = parsed?.kind === "money";
  useEffect(() => {
    if (!wantsMoney || target || !hasMoney) return;
    let live = true;
    void loadMoneyTarget().then(async (t) => {
      if (!live || !t) return;
      setTarget(t);
      setAccount(await captureAccount(t));
    });
    return () => {
      live = false;
    };
  }, [wantsMoney, target, hasMoney]);

  const preview = parsed ? describeCapture(parsed, { lifeOs, money: hasMoney, account: account?.name }) : null;

  const submit = async () => {
    if (!parsed || parsed.kind === "error" || busy) return;
    setBusy(true);
    const ok = await runCapture(parsed, account?.id);
    setBusy(false);
    if (ok) setText("");
  };

  return (
    <div className="hm-capture">
      <div className="hm-capture-field">
        <input
          ref={ref}
          className="hm-capture-input"
          value={text}
          disabled={busy}
          placeholder="Add a task, note or expense…"
          aria-label="Add a task, note or expense"
          aria-describedby="hm-capture-help"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              if (text) setText("");
              else e.currentTarget.blur();
            } else if (e.key === "Tab" && !e.shiftKey && parsed?.kind === "money" && target && target.accounts.length > 1) {
              e.preventDefault();
              const i = target.accounts.findIndex((a) => a.id === account?.id);
              setAccount(target.accounts[(i + 1) % target.accounts.length]);
            }
          }}
        />
        {!text ? (
          <span className="hm-capture-hint" aria-hidden>
            t call mum fri · n idea · −12.50 coffee
          </span>
        ) : null}
      </div>
      <p id="hm-capture-help" className={cn("hm-capture-preview", parsed?.kind === "error" && "is-error")} aria-live="polite">
        {preview ? (
          <>
            <span className="hm-capture-what">{preview.title}</span>
            {preview.meta.map((m) => (
              <span key={m} className="hm-capture-chip">
                {m}
              </span>
            ))}
            {parsed?.kind !== "error" ? (
              <span className="hm-capture-enter">
                <Kbd keys="enter" size="xs" />
                {parsed?.kind === "money" && target && target.accounts.length > 1 ? (
                  <>
                    <Kbd keys="tab" size="xs" /> account
                  </>
                ) : null}
              </span>
            ) : null}
          </>
        ) : text.trim() ? (
          <span className="hm-capture-what">Start with t for a task, n for a note, or − for an expense</span>
        ) : null}
      </p>
    </div>
  );
}
