/**
 * Home's one capture field (1.0 brief §2.6). Plain text is a task: it goes to Tasks when that app is installed, else
 * it becomes a to-do in today's note. The short prefixes keep working ("n …" a note, "−12.50 coffee" an expense,
 * "t …" a task with dates); a sentence that merely starts with "Note" or "Task" stays a task (capture.ts, plain
 * mode). What Enter will do is shown under the field before you press it. The field keeps focus after Enter (it is
 * read-only while saving, never disabled, so the next item can be typed straight away). The parser (chrono, decimal
 * maths) loads as its own chunk when the field is first focused, so Home's first paint doesn't wait for it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Id } from "@/backend/types";
import { cn } from "@/lib/cn";
import { useWorkspace } from "@/stores/workspace";
import { Kbd } from "@/ui/Kbd";
import type { MoneyTarget } from "@/features/search/capture";
import { loadExtras, useExtras } from "@/features/search/useExtras";

export function CaptureField({ autoFocus = false }: { autoFocus?: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const tasks = useWorkspace((s) => s.lifeapps.some((a) => a.appId === "life-os" && !a.detached));
  const hasMoney = useWorkspace((s) => s.lifeapps.some((a) => a.appId === "money-hq" && !a.detached));
  const [wanted, setWanted] = useState(autoFocus);
  const extras = useExtras(wanted || !!text);
  const parsed = useMemo(() => (extras && text.trim() ? extras.parseCapture(text, new Date(), { plain: true, money: hasMoney }) : null), [extras, text, hasMoney]);
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

  const preview = parsed && extras ? extras.describeCapture(parsed, { lifeOs: tasks, money: hasMoney, account: account?.name }) : null;

  const submit = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    // Enter pressed before the parser arrived still captures what was typed.
    const ex = extras ?? (await loadExtras().catch(() => null));
    const c = ex?.parseCapture(text, new Date(), { plain: true, money: hasMoney }) ?? null;
    const ok = !!ex && !!c && c.kind !== "error" && (await ex.runCapture(c, account?.id));
    setBusy(false);
    // The field stays ready for the next one (a toast's focus handling must not take it away).
    if (ok) setText("");
    if (ok && document.activeElement !== ref.current) ref.current?.focus({ preventScroll: true });
  };

  const where = tasks ? "Tasks" : "today’s note";
  return (
    <div className="hm-capture">
      <div className="hm-capture-field">
        <input
          ref={ref}
          className="hm-capture-input"
          value={text}
          readOnly={busy}
          aria-busy={busy || undefined}
          placeholder={tasks ? "Add a task…" : "Add a to-do to today’s note…"}
          aria-label={tasks ? "Add a task" : "Add a to-do to today’s note"}
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
        ) : (
          <span className="hm-capture-hint">
            Press <Kbd keys="enter" size="xs" /> to add it to {where}. “n idea” adds a note{hasMoney ? ", “−12.50 coffee” an expense" : ""}.
          </span>
        )}
      </p>
    </div>
  );
}
