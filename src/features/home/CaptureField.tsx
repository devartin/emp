/**
 * Home's one capture field: "Add a task, note or expense…". The same prefix grammar as ⌘K (search/capture.ts), with
 * the parse previewed under the field before Enter. Tab cycles the account of a money capture. The parser (chrono,
 * decimal maths) loads as its own chunk when the field is first focused, so Home's first paint doesn't wait for it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Id } from "@/backend/types";
import { cn } from "@/lib/cn";
import { useWorkspace } from "@/stores/workspace";
import { Kbd } from "@/ui/Kbd";
import type { MoneyTarget } from "@/features/search/capture";
import { loadExtras, useExtras } from "@/features/search/useExtras";

export function CaptureField({ autoFocus }: { autoFocus: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const lifeOs = useWorkspace((s) => s.lifeapps.some((a) => a.appId === "life-os" && !a.detached));
  const hasMoney = useWorkspace((s) => s.lifeapps.some((a) => a.appId === "money-hq" && !a.detached));
  const [wanted, setWanted] = useState(autoFocus);
  const extras = useExtras(wanted || !!text);
  const parsed = useMemo(() => (extras && text.trim() ? extras.parseCapture(text) : null), [extras, text]);
  const [target, setTarget] = useState<MoneyTarget | null>(null);
  const [account, setAccount] = useState<{ id: Id; name: string } | null>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  // Money captures preview the account they land in; load it the first time one is typed.
  const wantsMoney = parsed?.kind === "money";
  useEffect(() => {
    if (!wantsMoney || target || !hasMoney || !extras) return;
    let live = true;
    void extras.loadMoneyTarget().then(async (t) => {
      if (!live || !t) return;
      setTarget(t);
      setAccount(await extras.captureAccount(t));
    });
    return () => {
      live = false;
    };
  }, [wantsMoney, target, hasMoney, extras]);

  const preview = parsed && extras ? extras.describeCapture(parsed, { lifeOs, money: hasMoney, account: account?.name }) : null;

  const submit = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    // Enter pressed before the parser arrived still captures what was typed.
    const ex = extras ?? (await loadExtras().catch(() => null));
    const c = ex?.parseCapture(text) ?? null;
    const ok = !!ex && !!c && c.kind !== "error" && (await ex.runCapture(c, account?.id));
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
          onFocus={() => setWanted(true)}
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
